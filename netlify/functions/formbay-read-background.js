// Scheduled every 15 minutes (netlify.toml). Item 101 step 1: reads what Formbay holds for this
// account and keeps each answer exactly as it came, so the form to job mapping (stage, serial numbers,
// photos, documents, CCEW) is written from real forms. Read only: GET requests, nothing sent to Formbay.
//
// Reads: Formbay's own API documentation; the form lists; each recent form with its documents; the
// installer lists; and the links the newer API (api.formbay.com.au) hands out.
// Writes: formbay_webhook_events (finance roles read it), one row per address, event_type 'read.doc',
// 'read.trading' or 'read.api', the address in formbay_job_id. An address already kept in the last
// 6 hours is skipped, so a run with nothing new writes nothing.

const { getAdminClient } = require('./_shared/require-admin');
const { TRADING, API, formbayLogin, formbayGet, swaggerSpecFromHtml } = require('./_shared/formbay');

const MAX_REQUESTS = 90;
const FORMS_PER_LIST = 8;
// Never call anything that could change a form, or that sends back a file rather than data.
const NOT_A_READ = /zip|download|sdk|token|logout|delete|remove|submit|create|update|send|sign|validate|set_|save|upload|cancel|pay/i;

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
  const read = async (kind, url, { withToken = true } = {}) => {
    if (kept.has(url) || requests >= MAX_REQUESTS) return null;
    kept.add(url);
    requests++;
    const r = await formbayGet(url, withToken ? token : null);
    const { error } = await db.from('formbay_webhook_events').insert({
      event_type: kind, formbay_job_id: url,
      payload: r.json !== null ? { status: r.status, body: r.json } : null,
      raw_body: r.json !== null ? null : `HTTP ${r.status}\n${r.text || ''}`,
    });
    if (error) console.error('Formbay read: could not keep', url, error.message); else stored++;
    return r;
  };

  // 1. Formbay's documentation, so the mapping is written against their field list.
  const docPage = await read('read.doc', `${TRADING}/formbay/documentation`, { withToken: false });
  await read('read.doc', 'https://api-doc.formbay.com.au/', { withToken: false });
  const spec = docPage && docPage.text ? swaggerSpecFromHtml(docPage.text) : null;

  // 2. The form lists, then each recent form.
  const formIds = { pv: [], bstc: [] };
  for (const ftype of Object.keys(formIds)) {
    const r = await read('read.trading', `${TRADING}/client_api/${ftype}_form_list`);
    const list = r && r.json;
    const ids = (Array.isArray(list) ? list : (list && typeof list === 'object' ? Object.values(list).find(Array.isArray) || [] : []))
      .map(x => (x && typeof x === 'object' ? (x.formid || x.form_id || x.id) : x)).filter(Boolean);
    formIds[ftype] = ids.slice(-FORMS_PER_LIST);
  }
  for (const ftype of Object.keys(formIds)) {
    for (const id of formIds[ftype]) {
      const q = `formid=${encodeURIComponent(id)}`;
      await read('read.trading', `${TRADING}/client_api/get_jobs?ftype=${ftype}&${q}`);
      await read('read.trading', `${TRADING}/client_api/pv_form_docs?${q}`);
      await read('read.trading', `${TRADING}/client_api/pv_docs_list?${q}`);
    }
  }
  for (const p of ['pv_installers', 'pv_electricians', 'pv_designers', 'clients']) await read('read.trading', `${TRADING}/client_api/${p}`);

  // 3. Every other documented read that needs nothing, or only a form number (newest form of each type).
  if (spec && spec.paths) {
    const base = `${TRADING}${spec.basePath && spec.basePath !== '/' ? spec.basePath : ''}`;
    for (const [path, ops] of Object.entries(spec.paths)) {
      const op = ops && ops.get;
      if (!op || path.includes('{') || NOT_A_READ.test(path) || NOT_A_READ.test(op.operationId || '')) continue;
      const required = (op.parameters || []).filter(p => p.required && p.in === 'query').map(p => p.name);
      if (required.some(n => !['formid', 'ftype'].includes(n))) continue;
      const takesForm = (op.parameters || []).some(p => p.name === 'formid');
      if (!takesForm) { await read('read.trading', `${base}${path}`); continue; }
      for (const ftype of Object.keys(formIds)) {
        const id = formIds[ftype][formIds[ftype].length - 1];
        if (id) await read('read.trading', `${base}${path}?ftype=${ftype}&formid=${encodeURIComponent(id)}`);
      }
    }
  }

  // 4. The newer API answers with links to its other resources: follow them, one of each kind.
  const kindOf = (u) => u.replace(/\/\d+(?=\/|\?|$)/g, '/{id}');
  const seenKinds = new Set();
  const queue = [`${API}/entrypoint`];
  const linksIn = (v, out) => {
    if (typeof v === 'string') { if (v.startsWith(API) && !NOT_A_READ.test(v)) out.add(v.split('#')[0]); }
    else if (Array.isArray(v)) v.slice(0, 5).forEach(x => linksIn(x, out));
    else if (v && typeof v === 'object') Object.values(v).forEach(x => linksIn(x, out));
    return out;
  };
  for (let n = 0; queue.length && n < 30; n++) {
    const r = await read('read.api', queue.shift());
    if (!r || r.json === null) continue;
    for (const l of linksIn(r.json, new Set())) { const k = kindOf(l); if (!seenKinds.has(k)) { seenKinds.add(k); queue.push(l); } }
  }

  console.log(`Formbay read: ${requests} requests, ${stored} kept, forms pv ${formIds.pv.length} bstc ${formIds.bstc.length}, docs ${spec ? 'read' : 'not found'}`);
  return { statusCode: 200 };
};
