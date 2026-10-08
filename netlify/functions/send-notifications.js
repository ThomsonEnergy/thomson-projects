const { getAdminClient } = require('./_shared/require-admin');
const { deliverPending } = require('./_shared/push');

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

exports.handler = async () => {
  const admin = getAdminClient();
  try {
    const reminders = await createDueReminders(admin);
    const pushed = await deliverPending(admin);
    // housekeeping: read notifications older than 60 days, any older than 180
    await admin.from('notifications').delete().lt('created_at', new Date(Date.now() - 180 * 86400000).toISOString());
    await admin.from('notifications').delete().not('read_at', 'is', null).lt('created_at', new Date(Date.now() - 60 * 86400000).toISOString());
    return { statusCode: 200, body: JSON.stringify({ ok: true, reminders, pushed }) };
  } catch (err) {
    console.error('send-notifications failed:', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
