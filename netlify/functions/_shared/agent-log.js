// How workers report to the ops manager (docs/AI_AGENTS_PLAN.md, migration 20261019010000).
//
//   const { runAgent } = require('./_shared/agent-log');
//   exports.handler = () => runAgent('sync-gmail', async () => { ...; return { summary, quiet } });
//
// The work function returns { summary, details, needsMe, usage: { input_tokens, output_tokens },
// quiet, response }. Every run updates the worker's heartbeat. A run is written to agent_runs
// unless it is quiet (did nothing worth recording), or failed. When a worker keeps failing
// (nothing good for 3 of its usual gaps), a "Needs me" task is opened and the ops manager
// people get one alert; the task closes itself when the worker works again.
// Logging never stops the real work: any logging error is only written to the console.

const { getAdminClient } = require('./require-admin');

const AGENTS = {
  'supplier-bills': { label: 'Tally: supplier bill reader (invoice@)', every: 60 },
  'price-lists': { label: 'Price list reader (sales@ and invoice@)', every: 60 },
  'statements': { label: 'Bill checks and statement reconciler', every: 60 },
  'sync-gmail': { label: 'Email sync (sales@ and My inbox)', every: 5 },
  'mailbox-work': { label: 'Postie: email agent (sorting, labels, drafts, clean up)', every: 60 },
  'send-notifications': { label: 'Phone notifications', every: 1 },
  'sync-overheads-nightly': { label: 'Xero overheads sync (nightly)', every: 1440 },
  'archive-completed-jobs': { label: 'Archive completed jobs (nightly)', every: 1440 },
  'sweep-job-booked': { label: 'Job Booked check (nightly)', every: 1440 },
  'sweep-quote-expiry': { label: 'Quote and variation expiry (nightly)', every: 1440 },
  'sweep-licence-expiry': { label: 'Licence and insurance expiry (nightly)', every: 1440 },
  'ops-digest': { label: 'Ops manager 5am digest', every: 1440 },
};

async function managerIds(admin) {
  const { data } = await admin.from('company_settings').select('ops_manager_user_ids').eq('id', 1).maybeSingle();
  return data?.ops_manager_user_ids || [];
}

async function notifyManagers(admin, { kind, title, body, link, dedupe }) {
  for (const id of await managerIds(admin)) {
    await admin.rpc('create_notification', { p_user: id, p_kind: kind, p_title: title, p_body: body, p_link: link, p_actor: null, p_dedupe: dedupe });
  }
}

async function beat(admin, agent, ok, error) {
  const meta = AGENTS[agent] || { label: agent, every: 60 };
  const now = new Date().toISOString();
  const row = { agent, label: meta.label, expected_every_minutes: meta.every, updated_at: now };
  if (ok) row.last_ok_at = now; else { row.last_error_at = now; row.last_error = String(error || 'failed').slice(0, 500); }
  await admin.from('agent_heartbeats').upsert(row, { onConflict: 'agent' });

  const dedupe = `agent_down:${agent}`;
  if (ok) {
    await admin.from('agent_tasks').update({ status: 'done', resolved_at: now, body: `Working again since ${now.slice(0, 16).replace('T', ' ')} UTC.` })
      .eq('dedupe_key', dedupe).eq('status', 'open');
    return;
  }
  // only escalate when it has been failing for a while, not on one blip
  const { data: hb } = await admin.from('agent_heartbeats').select('last_ok_at').eq('agent', agent).maybeSingle();
  const lastOk = hb?.last_ok_at ? new Date(hb.last_ok_at).getTime() : 0;
  if (Date.now() - lastOk < 3 * meta.every * 60000) return;
  const { data: task } = await admin.from('agent_tasks').insert({
    agent, title: `${meta.label} is not working`, body: `Last error: ${String(error || 'failed').slice(0, 300)}`, link: '/ops.html', dedupe_key: dedupe,
  }).select('id').maybeSingle(); // the unique index stops a second open task for the same worker
  if (task) await notifyManagers(admin, { kind: 'agent_alert', title: `${meta.label} is not working`, body: String(error || 'failed').slice(0, 200), link: '/ops.html', dedupe: `${dedupe}:${task.id}` });
}

async function runAgent(agent, work) {
  const startedAt = new Date().toISOString();
  let result, failure;
  try { result = (await work()) || {}; } catch (err) { failure = err; }

  try {
    const admin = getAdminClient();
    await beat(admin, agent, !failure, failure?.message);
    if (failure || !result.quiet) {
      await admin.from('agent_runs').insert({
        agent, started_at: startedAt, finished_at: new Date().toISOString(),
        status: failure ? 'failed' : 'ok',
        summary: failure ? `Failed: ${failure.message}`.slice(0, 500) : (result.summary || 'Done'),
        details: failure ? null : (result.details || null),
        needs_me: failure ? 0 : (result.needsMe || 0),
        input_tokens: result?.usage?.input_tokens || 0,
        output_tokens: result?.usage?.output_tokens || 0,
      });
    }
  } catch (logErr) {
    console.error(`agent log for ${agent} failed:`, logErr.message);
  }

  if (failure) {
    console.error(`${agent} failed:`, failure.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: failure.message }) };
  }
  return result.response || { statusCode: 200, body: JSON.stringify({ ok: true, summary: result.summary }) };
}

module.exports = { runAgent, notifyManagers, managerIds, AGENTS };
