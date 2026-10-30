// 7am Sydney, every day (netlify.toml runs it at 20:20 and 21:20 UTC; only the 7am one works):
// backlog item 39, so no lead gets lost. Admin, Finance and Sales get one phone notification per
// lead still new (with a phone or email, no quote or job made from it) more than 48 hours after it
// came in, and one per website call request still pending after its requested time. Leads older
// than 30 days and call requests older than 7 days are left alone, so old data never floods anyone.
// Kind 'lead' (the same tick box as the instant notification), one per lead per day.

const { getAdminClient } = require('./_shared/require-admin');
const { runAgent } = require('./_shared/agent-log');

const PRICING_ROLES = ['admin', 'finance', 'sales']; // the same roles as is_pricing_role()
const DAY = 24 * 60 * 60 * 1000;

function sydneyHour() {
  return Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
}
const sydneyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const sydneyNowHm = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

exports.handler = async (event) => {
  const force = event && event.queryStringParameters && event.queryStringParameters.force === '1' && process.env.CONTEXT !== 'production';
  if (sydneyHour() !== 7 && !force) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'not 7am in Sydney' }) };
  return runAgent('remind-leads', async () => {
    const admin = getAdminClient();
    const today = sydneyToday();
    const now = Date.now();

    const { data: leads, error } = await admin.from('leads')
      .select('id, created_at, name, ai_title, email, phone, suburb, source, status')
      .or('status.eq.new,status.is.null')
      .lt('created_at', new Date(now - 2 * DAY).toISOString())
      .gte('created_at', new Date(now - 30 * DAY).toISOString())
      .order('created_at');
    if (error) throw error;
    const withContact = (leads || []).filter((l) => l.email || l.phone);
    const ids = withContact.map((l) => l.id);
    const { data: linked } = ids.length ? await admin.from('projects').select('lead_id').in('lead_id', ids) : { data: [] };
    const taken = new Set((linked || []).map((p) => p.lead_id));
    const waiting = withContact.filter((l) => !taken.has(l.id));

    const sevenAgo = new Date(now - 7 * DAY).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const { data: calls, error: cErr } = await admin.from('callback_requests')
      .select('id, name, phone, requested_date, requested_time, status')
      .in('status', ['pending', 'scheduled'])
      .gte('requested_date', sevenAgo).lte('requested_date', today);
    if (cErr) throw cErr;
    const hm = sydneyNowHm();
    const overdue = (calls || []).filter((c) => c.requested_date < today || String(c.requested_time).slice(0, 5) <= hm);

    if (!waiting.length && !overdue.length) return { summary: 'No leads or call requests waiting.', quiet: true };

    const { data: people } = await admin.from('profiles').select('id').in('role', PRICING_ROLES).eq('active', true);
    let sent = 0;
    const lines = [];
    for (const l of waiting) {
      const who = l.name || l.ai_title || l.email || l.phone;
      const days = Math.floor((now - new Date(l.created_at).getTime()) / DAY);
      const title = `Lead waiting ${days} days: ${who}${l.suburb ? ', ' + l.suburb : ''}`;
      const body = `${l.source ? 'From ' + l.source + '. ' : ''}No quote or job yet. Call them or make the quote from the lead.`;
      for (const p of people || []) {
        await admin.rpc('create_notification', { p_user: p.id, p_kind: 'lead', p_title: title, p_body: body, p_link: `/leads.html?id=${l.id}`, p_actor: null, p_dedupe: `lead-remind:${l.id}:${today}` });
        sent += 1;
      }
      lines.push(`${who} (${days}d)`);
    }
    for (const c of overdue) {
      const who = c.name || c.phone;
      const title = `Call request not done: ${who}`;
      const body = `Asked for a call ${c.requested_date} at ${String(c.requested_time).slice(0, 5)}. Call ${c.phone}, then mark it done on the Leads page.`;
      for (const p of people || []) {
        await admin.rpc('create_notification', { p_user: p.id, p_kind: 'lead', p_title: title, p_body: body, p_link: '/leads.html', p_actor: null, p_dedupe: `callback-remind:${c.id}:${today}` });
        sent += 1;
      }
      lines.push(`call request ${who}`);
    }
    const summary = `${waiting.length} lead(s) waiting over 2 days and ${overdue.length} call request(s) past their time, ${sent} reminder(s) sent.`;
    console.log(`remind-leads: ${summary}`);
    return { summary, details: lines.join('; ') };
  });
};
