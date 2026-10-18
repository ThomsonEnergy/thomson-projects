// Scheduled (netlify.toml): the ops manager's morning digest, 5am Sydney time.
//
// Runs at 18:00 and 19:00 UTC (5am in daylight saving and outside it) and only sends on the
// one that is 5am in Sydney. Pushes one notification to each ops manager person
// (company_settings.ops_manager_user_ids) and keeps the full text as an agent_runs row, which the
// Ops page (ops.html) shows. Also clears worker log rows older than 90 days.
//
// What it covers: what the workers did in the last 24 hours, what is waiting on a person (emailed
// bills to check, open "Needs me" tasks), and any worker that has stopped working.

const { getAdminClient } = require('./_shared/require-admin');
const { runAgent, notifyManagers } = require('./_shared/agent-log');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function sydneyHour() {
  return Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
}
const sydneyDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

async function buildDigest(admin) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [runsRes, beatsRes, tasksRes, billsRes, savedRes, pricesRes] = await Promise.all([
    admin.from('agent_runs').select('agent, status, summary, input_tokens, output_tokens').gte('started_at', since),
    admin.from('agent_heartbeats').select('*'),
    admin.from('agent_tasks').select('title').eq('status', 'open').order('created_at'),
    admin.from('supplier_bill_inbox').select('status').in('status', ['to_check', 'failed']),
    admin.from('supplier_bill_inbox').select('resolved_by').eq('status', 'saved').gte('resolved_at', since),
    admin.from('price_changes').select('status, kind, change_pct, resolved_by').or(`status.eq.waiting,resolved_at.gte.${since}`),
  ]);
  const runs = runsRes.data || [], beats = beatsRes.data || [], tasks = tasksRes.data || [];
  const toCheck = (billsRes.data || []).filter(b => b.status === 'to_check').length;
  const failedBills = (billsRes.data || []).filter(b => b.status === 'failed').length;
  const saved = savedRes.data || [];
  const savedAuto = saved.filter(s => !s.resolved_by).length;
  const prices = pricesRes.data || [];
  const priceWaiting = prices.filter(p => p.status === 'waiting').length;
  const priceAuto = prices.filter(p => p.status === 'applied' && !p.resolved_by).length;

  // a worker is down if it has not worked for 3 of its usual gaps
  const down = beats.filter(b => b.agent !== 'ops-digest' && (!b.last_ok_at || Date.now() - new Date(b.last_ok_at).getTime() > 3 * b.expected_every_minutes * 60000));
  const failedRuns = runs.filter(r => r.status === 'failed');
  const emails = runs.filter(r => r.agent === 'sync-gmail' && r.status === 'ok').length;
  const tokensIn = runs.reduce((n, r) => n + (r.input_tokens || 0), 0);
  const tokensOut = runs.reduce((n, r) => n + (r.output_tokens || 0), 0);

  const needs = [];
  if (toCheck) needs.push(`${plural(toCheck, 'emailed bill')} to check`);
  if (failedBills) needs.push(`${plural(failedBills, 'bill')} that could not be read`);
  if (priceWaiting) needs.push(`${plural(priceWaiting, 'price list change')} to check`);
  tasks.forEach(t => needs.push(t.title));

  const lines = [];
  lines.push(needs.length ? `Needs you: ${needs.join('; ')}.` : 'Nothing needs you.');
  lines.push(`Last 24 hours: ${plural(saved.length, 'bill')} saved${savedAuto ? ` (${savedAuto} automatically)` : ''}, email sync brought mail in ${plural(emails, 'time')}${priceAuto ? `, ${plural(priceAuto, 'material price')} updated from price lists` : ''}.`);
  if (down.length) lines.push(`Not working: ${down.map(d => d.label).join(', ')}.`);
  else lines.push('All workers OK.');
  if (failedRuns.length) lines.push(`${plural(failedRuns.length, 'failed run')} in the last 24 hours.`);
  if (tokensIn || tokensOut) lines.push(`AI used: ${tokensIn.toLocaleString('en-AU')} tokens in, ${tokensOut.toLocaleString('en-AU')} out.`);

  const needCount = toCheck + failedBills + tasks.length + priceWaiting;
  const title = down.length ? `Morning: ${down[0].label} is not working`
    : needCount ? `Morning: ${plural(needCount, 'thing')} need${needCount === 1 ? 's' : ''} you`
    : 'Morning: all clear';
  return { title, text: lines.join(' '), needCount, down: down.map(d => d.agent) };
}

exports.handler = async (event) => {
  // the 18:00 and 19:00 UTC runs: only the one that is 5am in Sydney sends
  if (sydneyHour() !== 5 && !(event && event.queryStringParameters && event.queryStringParameters.force === '1' && process.env.CONTEXT !== 'production')) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'not 5am in Sydney' }) };
  }
  return runAgent('ops-digest', async () => {
    const admin = getAdminClient();
    const digest = await buildDigest(admin);
    await notifyManagers(admin, { kind: 'ops_digest', title: digest.title, body: digest.text.slice(0, 300), link: '/ops.html', dedupe: `ops_digest:${sydneyDate()}` });
    await admin.from('agent_runs').delete().lt('started_at', new Date(Date.now() - 90 * 86400000).toISOString());
    return { summary: `${digest.title}. ${digest.text}`, details: digest, needsMe: digest.needCount };
  });
};
