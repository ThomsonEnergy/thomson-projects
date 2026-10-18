const { getAdminClient } = require('./_shared/require-admin');
const { deliverPending } = require('./_shared/push');
const { runAgent } = require('./_shared/agent-log');

// Runs every minute (netlify.toml). Two jobs:
//  1. Timed reminders: a meeting action (job_tasks.remind_at) whose reminder time
//     has come becomes a "task_reminder" notification for whoever it is assigned to.
//  2. Phone push: sends every new notification row to its owner's subscribed
//     devices. (Rows themselves are made by database triggers when things happen.)

async function createDueReminders(admin) {
  const now = new Date();
  const { data: tasks, error } = await admin.from('job_tasks')
    .select('id, description, assigned_to_user_id, project_id, meeting_id, remind_at, remind_notified_at')
    .eq('completed', false).not('assigned_to_user_id', 'is', null)
    .lte('remind_at', now.toISOString()).gt('remind_at', new Date(now.getTime() - 14 * 86400000).toISOString());
  if (error) throw error;
  const due = (tasks || []).filter(t => !t.remind_notified_at || new Date(t.remind_notified_at) < new Date(t.remind_at));
  for (const t of due) {
    const link = t.meeting_id ? `/meetings.html?id=${t.meeting_id}` : (t.project_id ? `/project.html?id=${t.project_id}` : '/tasks.html');
    await admin.rpc('create_notification', {
      p_user: t.assigned_to_user_id, p_kind: 'task_reminder', p_title: 'Reminder: ' + t.description, p_body: 'This is due for follow-up. Tick it off when it is done.',
      p_link: link, p_actor: null, p_dedupe: `remind:${t.id}:${new Date(t.remind_at).getTime()}`,
    });
    await admin.from('job_tasks').update({ remind_notified_at: now.toISOString() }).eq('id', t.id);
  }
  return due.length;
}

// Call requests from the website are saved with the caller's chosen date and
// time as plain local (Sydney) values, so work out the real moment they mean,
// including daylight saving.
function sydneyLocalToUtc(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms));
    const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - ms;
  };
  return guess - offsetAt(guess - offsetAt(guess));
}

// A claimed call request becomes a "call_reminder" notification for whoever
// claimed it from 5 minutes before its time (and for up to 15 minutes after, in
// case a run was missed). The dedupe key means it is only ever made once.
async function createDueCallReminders(admin) {
  const now = Date.now();
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const { data: calls, error } = await admin.from('callback_requests')
    .select('id, name, phone, requested_date, requested_time, claimed_by')
    .not('claimed_by', 'is', null).eq('status', 'scheduled')
    .gte('requested_date', day(now - 2 * 86400000)).lte('requested_date', day(now + 2 * 86400000));
  if (error) throw error;
  let made = 0;
  for (const c of (calls || [])) {
    const start = sydneyLocalToUtc(c.requested_date, c.requested_time);
    if (now < start - 5 * 60000 || now > start + 15 * 60000) continue;
    const at = new Date(start).toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', minute: '2-digit' });
    await admin.rpc('create_notification', {
      p_user: c.claimed_by, p_kind: 'call_reminder', p_title: `Call ${c.name || 'the customer'} at ${at}`,
      p_body: c.phone ? `${c.phone} - starting soon` : 'Starting soon', p_link: '/home.html', p_actor: null, p_dedupe: `callback:${c.id}`,
    });
    made++;
  }
  return made;
}

exports.sydneyLocalToUtc = sydneyLocalToUtc;
// Reports to the ops manager (_shared/agent-log.js) as a heartbeat only: runs every minute,
// so only failures are logged.
exports.handler = () => runAgent('send-notifications', async () => {
  const admin = getAdminClient();
  const reminders = await createDueReminders(admin);
  const callReminders = await createDueCallReminders(admin);
  const pushed = await deliverPending(admin);
  // housekeeping: read notifications older than 60 days, any older than 180
  await admin.from('notifications').delete().lt('created_at', new Date(Date.now() - 180 * 86400000).toISOString());
  await admin.from('notifications').delete().not('read_at', 'is', null).lt('created_at', new Date(Date.now() - 60 * 86400000).toISOString());
  return { quiet: true, response: { statusCode: 200, body: JSON.stringify({ ok: true, reminders, callReminders, pushed }) } };
});
