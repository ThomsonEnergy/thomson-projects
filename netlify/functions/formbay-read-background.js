// Scheduled every 15 minutes (netlify.toml). Item 101, solar and hot water: reads this account's
// solar (PV), solar with battery and hot water (SWH) forms from Formbay and keeps each answer as it
// came, so those forms are mapped from real ones (the battery form was done the same way on
// 20 Nov 2026). Read only: nothing on a Formbay form changes. Removed once the mapping is built.
// Writes: formbay_webhook_events (finance roles read it), one row per address, event_type
// 'read.trading'. An address already kept in the last 6 hours is skipped.

const { getAdminClient } = require('./_shared/require-admin');
const { formbayLogin, formbayCall } = require('./_shared/formbay');

const MAX_REQUESTS = 70;
const MAX_FORMS = 6;

exports.handler = async () => {
  const db = getAdminClient();
  const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const { data: recent, error: recentErr } = await db.from('formbay_webhook_events')
    .select('formbay_job_id').eq('event_type', 'read.trading').gte('received_at', since).limit(1000);
  if (recentErr) { console.error('Formbay read:', recentErr.message); return { statusCode: 500 }; }
  const kept = new Set((recent || []).map(r => r.formbay_job_id));

  let token;
  try { token = await formbayLogin(); } catch (err) { console.error('Formbay read:', err.message); return { statusCode: 200 }; }

  let requests = 0;
  const read = async (path, opts = {}) => {
    const key = opts.form ? `${path} POST ${new URLSearchParams(opts.form)}` : path;
    if (kept.has(key) || requests >= MAX_REQUESTS) return null;
    kept.add(key);
    requests++;
    const r = await formbayCall(token, path, opts);
    const { error } = await db.from('formbay_webhook_events').insert({
      event_type: 'read.trading', formbay_job_id: key,
      payload: r.json !== null ? { status: r.status, body: r.json } : null,
      raw_body: r.json !== null ? null : `HTTP ${r.status}\n${r.text || ''}`,
    });
    if (error) console.error('Formbay read: could not keep', key, error.message);
    return r;
  };
  const ids = async (path) => { const r = await formbayCall(token, path); return (Array.isArray(r.json) ? r.json : []).map(String).slice(-MAX_FORMS); };
  const groups = await formbayCall(token, 'clients');
  const group = Array.isArray(groups.json) ? String(groups.json[0]) : '';

  const lists = { pv: await ids('pv_form_list'), bstc: await ids('bstc_form_list'), swh: await ids('swh_form_list') };
  await read('pv_form_list');
  await read('swh_form_list');
  await read('bstc_form_list');
  await read('pv_form_list?version=2&size=5', { timeout: 60000 });

  for (const id of lists.pv) {
    await read(`pv_form?formid=${id}`);
    await read(`pv_form_docs?formid=${id}`);
    await read('pv_docs_list', { form: { formid: id, group_id: group } });
    await read('pv_bstc_docs_list', { form: { formid: id, group_id: group } });
    await read(`fb2_forms?ftype=pv&formid=${id}`);
  }
  for (const id of lists.bstc) {
    await read(`bstc_form?formid=${id}`);
    await read(`fb2_forms?ftype=bstc&formid=${id}`);
  }
  for (const id of lists.swh) {
    await read(`swh_form?formid=${id}`);
    await read('swh_docs_list', { form: { formid: id, group_id: group } });
  }
  await read('pv_panel_brands');
  console.log(`Formbay read: ${requests} requests, pv ${lists.pv.length}, bstc ${lists.bstc.length}, swh ${lists.swh.length}`);
  return { statusCode: 200 };
};
