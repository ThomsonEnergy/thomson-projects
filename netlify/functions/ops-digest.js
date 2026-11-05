// Scheduled (netlify.toml): the ops manager's morning digest, 5am Sydney time.
//
// Runs at 18:00 and 19:00 UTC (5am in daylight saving and outside it) and only sends on the
// one that is 5am in Sydney. Pushes one notification to each ops manager person
// (company_settings.ops_manager_user_ids) and keeps the full text as an agent_runs row, which the
// Ops page (ops.html) shows. Also clears worker log rows older than 90 days.
//
// What it covers: what is new since yesterday (the last 24 hours), what is still waiting on a
// person (emailed bills to check, stock running low, open "Needs me" tasks), and any worker that
// has stopped working. The push says only what is new and is not sent at all when nothing is new
// and every worker is working (item 54); the full text, with mail and AI use, is on the Ops page. Emailed bills, price lists, statements and stock low make no bell row of their own
// (migration 20261120000000): this digest and the Ops page are where they show.

const { getAdminClient } = require('./_shared/require-admin');
const { runAgent, notifyManagers } = require('./_shared/agent-log');
const { missingStatements } = require('./_shared/statement-intake');

const plural = (n, word, many) => `${n} ${n === 1 ? word : (many || word + 's')}`;

function sydneyHour() {
  return Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
}
const sydneyDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

async function buildDigest(admin) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [runsRes, beatsRes, tasksRes, billsRes, savedRes, pricesRes, checkRes, stIssuesRes, missingSts, lowRes] = await Promise.all([
    admin.from('agent_runs').select('agent, status, summary, input_tokens, output_tokens').gte('started_at', since),
    admin.from('agent_heartbeats').select('*'),
    admin.from('agent_tasks').select('title, dedupe_key, created_at').eq('status', 'open').order('created_at'),
    admin.from('supplier_bill_inbox').select('status, created_at, processed_at').in('status', ['to_check', 'failed']),
    admin.from('supplier_bill_inbox').select('resolved_by').eq('status', 'saved').gte('resolved_at', since),
    admin.from('price_changes').select('status, kind, change_pct, resolved_by, created_at').or(`status.eq.waiting,resolved_at.gte.${since}`),
    admin.from('supplier_bills').select('check_status, approved_for_payment, created_at, query_reply_at').eq('paid', false).in('check_status', ['matches', 'resolved', 'problems', 'queried']),
    admin.from('supplier_statements').select('created_at, query_reply_at').eq('status', 'issues'),
    missingStatements(admin),
    admin.from('stock_low_flags').select('created_at').is('cleared_at', null),
  ]);
  const runs = runsRes.data || [], beats = beatsRes.data || [];
  // a worker-down task is already the "Not working" line, so it is not listed twice
  const tasks = (tasksRes.data || []).filter(t => !String(t.dedupe_key || '').startsWith('agent_down:'));
  const cutoff = Date.parse(since);
  const isNew = (iso) => !!iso && Date.parse(iso) >= cutoff;
  // an emailed bill is read up to an hour after it arrives, so its 24 hours run 2 hours behind:
  // each bill is new in exactly one digest, and Try again never makes it new again
  const LAG = 2 * 3600 * 1000;
  const isNewEmail = (iso) => !!iso && Date.parse(iso) >= cutoff - LAG && Date.parse(iso) < Date.now() - LAG;
  const bills = billsRes.data || [];
  const saved = savedRes.data || [];
  const savedAuto = saved.filter(s => !s.resolved_by).length;
  const prices = pricesRes.data || [];
  const priceAuto = prices.filter(p => p.status === 'applied' && !p.resolved_by).length;
  const checks = checkRes.data || [];
  const sts = stIssuesRes.data || [];
  // open queries: a supplier's reply waits on a person, no reply yet waits on the supplier
  const queried = checks.filter(b => b.check_status === 'queried');
  const replies = [...queried.filter(b => b.query_reply_at), ...sts.filter(r => r.query_reply_at)];
  const noReply = queried.filter(b => !b.query_reply_at); // waits on the supplier: listed, never "new", not in needCount
  const lows = lowRes.data || [];

  // each kind: [one, many, rows still waiting, is this row new since yesterday].
  // A bill is new by when it was saved (created_at), not checked_at, which every re-check moves.
  const kinds = [
    ['emailed bill to check', 'emailed bills to check', bills.filter(b => b.status === 'to_check'), (b) => isNewEmail(b.created_at)],
    ['bill that could not be read', 'bills that could not be read', bills.filter(b => b.status === 'failed'), (b) => isNewEmail(b.created_at)],
    ['bill not matching the PO', 'bills not matching the PO', checks.filter(b => b.check_status === 'problems'), (b) => isNew(b.created_at)],
    ['bill to approve for payment', 'bills to approve for payment', checks.filter(b => ['matches', 'resolved'].includes(b.check_status) && !b.approved_for_payment), (b) => isNew(b.created_at)],
    ['statement not reconciling', 'statements not reconciling', sts, (r) => isNew(r.created_at)],
    ['supplier reply to a query', 'supplier replies to queries', replies, (r) => isNew(r.query_reply_at)],
    ['price list change to check', 'price list changes to check', prices.filter(p => p.status === 'waiting'), (p) => isNew(p.created_at)],
    ['stock item running low', 'stock items running low', lows, (r) => isNew(r.created_at)],
  ].map(([one, many, rows, fresh]) => ({ one, many, all: rows.length, fresh: rows.filter(fresh).length }));
  const newTasks = tasks.filter(t => isNew(t.created_at));
  const newParts = [...kinds.filter(k => k.fresh).map(k => plural(k.fresh, k.one, k.many)), ...newTasks.map(t => t.title)];
  const waitParts = [...kinds.filter(k => k.all).map(k => plural(k.all, k.one, k.many)), ...tasks.map(t => t.title)];
  if (missingSts.length) waitParts.push(`no statement yet from ${missingSts.map(m => m.name).join(', ')}`);
  if (noReply.length) waitParts.push(plural(noReply.length, 'query', 'queries') + ' waiting on suppliers');
  const newCount = kinds.reduce((n, k) => n + k.fresh, 0) + newTasks.length;
  const needCount = kinds.reduce((n, k) => n + k.all, 0) + tasks.length + missingSts.length;

  // a worker is down if it has not worked for 3 of its usual gaps
  const down = beats.filter(b => b.agent !== 'ops-digest' && (!b.last_ok_at || Date.now() - new Date(b.last_ok_at).getTime() > 3 * b.expected_every_minutes * 60000));
  const failedRuns = runs.filter(r => r.status === 'failed');
  const emails = runs.filter(r => r.agent === 'sync-gmail' && r.status === 'ok').length;
  const tokensIn = runs.reduce((n, r) => n + (r.input_tokens || 0), 0);
  const tokensOut = runs.reduce((n, r) => n + (r.output_tokens || 0), 0);

  const pushLines = [];
  if (down.length) pushLines.push(`Not working: ${down.map(d => d.label).join(', ')}.`);
  if (newParts.length) pushLines.push(`New since yesterday: ${newParts.join('; ')}.`);
  if (waitParts.length) pushLines.push(`Still waiting: ${waitParts.join('; ')}.`);
  const lines = [...pushLines];
  if (!waitParts.length) lines.push('Nothing needs you.');
  lines.push(`Last 24 hours: ${plural(saved.length, 'bill')} saved${savedAuto ? ` (${savedAuto} automatically)` : ''}, email sync brought mail in ${plural(emails, 'time')}${priceAuto ? `, ${plural(priceAuto, 'material price')} updated from price lists` : ''}.`);
  if (!down.length) lines.push('All workers OK.');
  if (failedRuns.length) lines.push(`${plural(failedRuns.length, 'failed run')} in the last 24 hours.`);
  if (tokensIn || tokensOut) lines.push(`AI used: ${tokensIn.toLocaleString('en-AU')} tokens in, ${tokensOut.toLocaleString('en-AU')} out.`);

  const title = down.length ? `Morning: ${down[0].label} is not working`
    : newCount ? `Morning: ${plural(newCount, 'new thing')} since yesterday`
    : 'Morning: nothing new';
  const push = !!(down.length || newCount);
  return { title, text: lines.join(' '), pushText: pushLines.join(' '), push, newCount, needCount, down: down.map(d => d.agent) };
}

// The Schedule of Rates is reviewed every 6 months (company_settings.rates_reviewed_on, set from
// Settings > Billable Rates). When it is due, one "Needs me" task is opened (and listed in the
// digest); it closes itself once the date is moved on.
async function ratesReviewCheck(admin) {
  const dedupe = 'rates_review';
  const { data } = await admin.from('company_settings').select('rates_reviewed_on').eq('id', 1).maybeSingle();
  const reviewed = data?.rates_reviewed_on;
  const due = reviewed ? new Date(reviewed + 'T00:00:00Z') : null;
  if (due) due.setUTCMonth(due.getUTCMonth() + 6);
  if (due && due.toISOString().slice(0, 10) > sydneyDate()) {
    await admin.from('agent_tasks').update({ status: 'done', resolved_at: new Date().toISOString(), body: `Reviewed ${reviewed}.` })
      .eq('dedupe_key', dedupe).eq('status', 'open');
    return;
  }
  const { data: task } = await admin.from('agent_tasks').insert({
    agent: 'ops-digest', title: 'Review the Schedule of Rates (6 monthly)',
    body: `Last reviewed ${reviewed || 'never'}. Check the rates in Settings > Billable Rates, then press "Rates checked" (or change a rate).`,
    link: '/settings.html?panel=billable-rates', dedupe_key: dedupe,
  }).select('id').maybeSingle(); // the unique index stops a second open reminder
  if (task) await notifyManagers(admin, { kind: 'agent_alert', title: 'Review the Schedule of Rates', body: 'It is 6 months since the rates were last checked.', link: '/settings.html?panel=billable-rates', dedupe: `${dedupe}:${task.id}` });
}

exports.handler = async (event) => {
  // the 18:00 and 19:00 UTC runs: only the one that is 5am in Sydney sends
  if (sydneyHour() !== 5 && !(event && event.queryStringParameters && event.queryStringParameters.force === '1' && process.env.CONTEXT !== 'production')) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'not 5am in Sydney' }) };
  }
  return runAgent('ops-digest', async () => {
    const admin = getAdminClient();
    await ratesReviewCheck(admin).catch((err) => console.error('rates review check failed:', err.message));
    const digest = await buildDigest(admin);
    // nothing new and every worker working: no push, the digest is still on the Ops page
    if (digest.push) await notifyManagers(admin, { kind: 'ops_digest', title: digest.title, body: digest.pushText.slice(0, 300), link: '/ops.html', dedupe: `ops_digest:${sydneyDate()}` });
    await admin.from('agent_runs').delete().lt('started_at', new Date(Date.now() - 90 * 86400000).toISOString());
    return { summary: `${digest.title}. ${digest.text}`, details: digest, needsMe: digest.needCount };
  });
};
