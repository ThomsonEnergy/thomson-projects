// Scheduled every 15 minutes (netlify.toml). Item 101 step 1: reads what Formbay holds for this
// account and keeps each answer exactly as it came, so the form to job mapping (stage, serial numbers,
// photos, documents, CCEW) is written from real forms. Read only: nothing on a Formbay form changes
// (GET requests, plus Formbay's document list, which is read with a POST).
//
// Reads: every battery (BSTC) form with its stage, its details, its documents and its linked forms;
// the people a form can be given to; the battery series and models of the brands on those forms.
// Writes: formbay_webhook_events (finance roles read it), one row per address, event_type
// 'read.trading', the address in formbay_job_id. An address already kept in the last 6 hours is
// skipped, so a run with nothing new writes nothing.

const { getAdminClient } = require('./_shared/require-admin');
const { TRADING, formbayLogin, formbayGet } = require('./_shared/formbay');

const MAX_REQUESTS = 60;
const MAX_FORMS = 10;

exports.handler = async () => {
  const db = getAdminClient();
  const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const { data: recent, error: recentErr } = await db.from('formbay_webhook_events')
    .select('formbay_job_id').like('event_type', 'read.%').gte('received_at', since).limit(1000);
  if (recentErr) { console.error('Formbay read: could not check what is kept', recentErr.message); return { statusCode: 500 }; }
  const kept = new Set((recent || []).map(r => r.formbay_job_id));

  let token;
  try { token = await formbayLogin(); } catch (err) { console.error('Formbay read:', err.message); return { statusCode: 200 }; }

  let requests = 0, stored = 0;
  // Read one address once, keep the answer, hand it back (null when skipped or over the limit).
  const read = async (path, form = null) => {
    const url = `${TRADING}/client_api/${path}`;
    const key = form ? `${url} POST ${new URLSearchParams(form)}` : url;
    if (kept.has(key) || requests >= MAX_REQUESTS) return null;
    kept.add(key);
    requests++;
    const r = await formbayGet(url, token, { form });
    const { error } = await db.from('formbay_webhook_events').insert({
      event_type: 'read.trading', formbay_job_id: key,
      payload: r.json !== null ? { status: r.status, body: r.json } : null,
      raw_body: r.json !== null ? null : `HTTP ${r.status}\n${r.text || ''}`,
    });
    if (error) console.error('Formbay read: could not keep', key, error.message); else stored++;
    return r;
  };
  const q = (params) => new URLSearchParams(params).toString();

  // The forms, newest first, with stage, signatures, what each is waiting on, sale and payment.
  // (The second version of the list is kept under its own address, so a later run still reads the ids.)
  await read(`bstc_form_list?${q({ version: 2, size: 100 })}`);
  const idsRes = await formbayGet(`${TRADING}/client_api/bstc_form_list`, token);
  const ids = (Array.isArray(idsRes.json) ? idsRes.json : []).slice(-MAX_FORMS);

  const clientsRes = await formbayGet(`${TRADING}/client_api/clients`, token);
  const groupId = Array.isArray(clientsRes.json) ? clientsRes.json[0] : null;
  if (groupId) await read(`ccew_contractors?${q({ group_id: groupId })}`);

  const brands = new Map();
  for (const id of ids) {
    const formRes = await formbayGet(`${TRADING}/client_api/bstc_form?${q({ formid: id })}`, token);
    for (const b of (formRes.json && formRes.json.batteries) || []) if (b.brand) brands.set(b.brand, b.series || b.b_series);
    await read(`fb2_forms?${q({ ftype: 'bstc', formid: id })}`);
    const docs = await read('bstc_docs_list', groupId ? { formid: id, group_id: groupId } : { formid: id });
    // One document from each form, to see how a file comes back (the address, never the file itself).
    const fileId = docs && firstValue(docs.json, ['fileid', 'file_id']);
    if (fileId) {
      await read(`bstc_doc?${q({ fileid: fileId })}`);
      await read(`bstc_doc?${q({ fileid: fileId, stamp: 1 })}`);
    }
  }
  for (const [brand, series] of brands) {
    await read(`pv_inverter_battery_series?${q({ b_brand: brand, bstc: 1 })}`);
    if (series) await read(`pv_inverter_battery_models?${q({ b_brand: brand, b_series: series, bstc: 1 })}`);
  }

  console.log(`Formbay read: ${requests} requests, ${stored} kept, ${ids.length} forms`);
  return { statusCode: 200 };
};

// The first value under any of these keys, however deep the answer nests it.
function firstValue(v, keys) {
  if (Array.isArray(v)) { for (const x of v) { const f = firstValue(x, keys); if (f) return f; } return null; }
  if (!v || typeof v !== 'object') return null;
  for (const k of keys) if (v[k]) return v[k];
  for (const x of Object.values(v)) { const f = firstValue(x, keys); if (f) return f; }
  return null;
}
