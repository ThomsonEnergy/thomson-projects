// Scheduled function (see netlify.toml): just after midnight Sydney time.
// Licence expiry agent (migration 20261103000000):
//   1. employee licences: reminds the employee 30, 14 and 7 days before, on the day it runs out,
//      then every 7 days while it stays expired. A note written in the last 30 days (for example
//      "Paid renewal, waiting on card") pauses the employee's reminders; Admin still hears.
//   2. company licences and insurance, and every employee licence above: Admin gets one
//      notification a night listing what hit a reminder point.
// Stops once a new expiry date is saved. Each reminder is sent once (dedupe key per point).

const { getAdminClient } = require('./_shared/require-admin');
const { runAgent } = require('./_shared/agent-log');

const sydneyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }); // YYYY-MM-DD
const daysBetween = (from, to) => Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000);
const longDate = (ymd) => new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const POINTS = [30, 14, 7, 0];
const isPoint = (days) => POINTS.includes(days) || (days < 0 && -days % 7 === 0);
const when = (days, expiry) => days > 0 ? `runs out in ${days} days (${longDate(expiry)})` : days === 0 ? 'runs out today' : `expired ${longDate(expiry)}`;
const NOTE_PAUSE_DAYS = 30;

exports.handler = () => runAgent('sweep-licence-expiry', async () => {
  const supabaseAdmin = getAdminClient();
  const today = sydneyToday();
  const notify = (user, title, body, link, dedupe) => supabaseAdmin.rpc('create_notification',
    { p_user: user, p_kind: 'licence', p_title: title, p_body: body, p_link: link, p_actor: null, p_dedupe: dedupe });

  const [{ data: licences, error: licErr }, { data: creds, error: credErr }, { data: people, error: pplErr }] = await Promise.all([
    supabaseAdmin.from('profile_licences').select('id, profile_id, licence_name, expiry_date, notes, notes_updated_at').not('expiry_date', 'is', null).lte('expiry_date', addDays(today, 30)),
    supabaseAdmin.from('company_credentials').select('id, credential_type, name, expiry_date, notes').not('expiry_date', 'is', null).lte('expiry_date', addDays(today, 30)),
    supabaseAdmin.from('profiles').select('id, full_name, role, active'),
  ]);
  if (licErr || credErr || pplErr) throw new Error((licErr || credErr || pplErr).message);
  const byId = Object.fromEntries((people || []).map(p => [p.id, p]));
  const admins = (people || []).filter(p => p.active && p.role === 'admin').map(p => p.id);

  const adminLines = [];
  let employeeSent = 0, paused = 0;
  for (const l of licences || []) {
    const owner = byId[l.profile_id];
    if (!owner || !owner.active) continue;
    const days = daysBetween(today, l.expiry_date);
    if (!isPoint(days)) continue;
    const noteRecent = l.notes && l.notes_updated_at && daysBetween(l.notes_updated_at.slice(0, 10), today) <= NOTE_PAUSE_DAYS;
    adminLines.push(`${owner.full_name || 'Staff'}: ${l.licence_name} ${when(days, l.expiry_date)}${l.notes ? ` (note: ${l.notes})` : ''}`);
    if (noteRecent) { paused++; continue; }
    await notify(l.profile_id, days < 0 ? `Your ${l.licence_name} has expired` : `Your ${l.licence_name} ${when(days, l.expiry_date)}`,
      'Renew it, then upload the new licence and its expiry date in Settings, My licences. Add a note there if the renewal is under way.',
      `/settings.html?licence=${l.id}`, `licence-expiry-${l.id}-${l.expiry_date}-${days}`);
    employeeSent++;
  }
  for (const c of creds || []) {
    const days = daysBetween(today, c.expiry_date);
    if (!isPoint(days)) continue;
    adminLines.push(`Company ${c.credential_type}: ${c.name} ${when(days, c.expiry_date)}${c.notes ? ` (note: ${c.notes})` : ''}`);
  }

  if (adminLines.length) {
    for (const id of admins) {
      await notify(id, `Licences and insurance: ${adminLines.length} to check`, adminLines.join('; '), '/team.html#insurance-section', `licence-admin-${today}`);
    }
  }

  const summary = `${adminLines.length} at a reminder point, ${employeeSent} employee reminder(s), ${paused} paused by a note.`;
  console.log(`sweep-licence-expiry: ${summary}`);
  return { summary, details: adminLines.join('; ') || null, quiet: !adminLines.length };
});

function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
