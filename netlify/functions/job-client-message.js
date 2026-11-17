// POST /.netlify/functions/job-client-message   (backlog item 74 PR 2)
// Staff side of the client portal:
//   { action: 'reply', projectId, body, email }   a message on the job's thread with the client (the
//        Feed tab's Client messages card). It shows in their portal at once; with email true it also
//        goes to them from sales@ in the sender's name, recorded on the job. Any active staff member.
//   { action: 'extend', projectId, date, reason }  a quote the client asked for in the portal will be
//        late: the new due date and why. The portal shows "due <date> (moved)" and the client gets an
//        email. Admin, Finance and Sales only.
// Writes job_client_messages, projects (client_due_date, client_due_note), activity_log and the
// email tables (through _shared/send-recorded-email.js).

const { requireActiveUser } = require('./_shared/require-active-user');
const { sendAsUser } = require('./_shared/send-recorded-email');
const E = require('./_shared/schedule-emails');
const { portalLine } = require('./_shared/portal-mail');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PRICING = ['admin', 'finance', 'sales'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin: admin, user } = auth;
  try {
    const body = JSON.parse(event.body || '{}');
    if (!UUID.test(body.projectId || '')) return json(400, { ok: false, error: 'Which job?' });
    const { data: project } = await admin.from('projects').select('id, name, job_number, quote_number, client_name, client_email, job_contact_id, client_due_date, portal_requested_at, sent_at').eq('id', body.projectId).maybeSingle();
    if (!project) return json(404, { ok: false, error: 'Job not found.' });
    const { data: me } = await admin.from('profiles').select('full_name, role').eq('id', user.id).maybeSingle();

    if (body.action === 'reply') {
      const text = String(body.body || '').trim().slice(0, 4000);
      if (!text) return json(400, { ok: false, error: 'Write a message first.' });
      // the email goes first: if it fails nothing is saved, so trying again never posts the message twice
      let emailed = false;
      let warning = null;
      if (body.email) {
        const rec = await E.recipientFor(admin, project);
        if (rec.to) {
          await sendAsUser(admin, {
            userId: user.id, to: rec.to, subject: `${E.jobTitle(project)}: a message from us`,
            bodyText: `Hi ${rec.first},\n\n${text}${await portalLine(admin, rec.to)}`, tagProjectId: project.id, tagKind: 'client',
          });
          emailed = true;
        } else warning = 'Saved in the portal, but there is no client email on this job, so no email went.';
      }
      const { error } = await admin.from('job_client_messages').insert({ project_id: project.id, author_id: user.id, body: text, emailed_at: emailed ? new Date().toISOString() : null });
      if (error) throw error;
      await admin.from('activity_log').insert({ entity_type: 'project', entity_id: project.id, action: 'client_message_reply', changed_by: user.id, description: `${(me && me.full_name) || 'Someone'} wrote to the client${emailed ? ' (emailed)' : ''}: "${text.slice(0, 200)}"` });
      return json(200, { ok: true, emailed, warning });
    }

    if (body.action === 'extend') {
      if (!me || !PRICING.includes(me.role)) return json(403, { ok: false, error: 'Only Admin, Finance and Sales can move a due date.' });
      if (!project.portal_requested_at || project.job_number || project.sent_at) return json(400, { ok: false, error: 'Only a quote the client asked for in the portal, before it is sent.' });
      const date = String(body.date || '');
      const reason = String(body.reason || '').trim().slice(0, 300);
      if (!DATE.test(date) || date <= E.sydneyToday()) return json(400, { ok: false, error: 'Pick a new date from tomorrow on.' });
      if (!reason) return json(400, { ok: false, error: 'Say why, in a few words: the client sees it.' });
      const was = project.client_due_date;
      await admin.from('projects').update({ client_due_date: date, client_due_note: reason }).eq('id', project.id);
      await admin.from('activity_log').insert({ entity_type: 'project', entity_id: project.id, action: 'client_due_moved', changed_by: user.id, description: `Quote due date moved${was ? ` from ${E.fmtDay(was)}` : ''} to ${E.fmtDay(date)}: ${reason}` });
      const rec = await E.recipientFor(admin, project);
      let emailed = false;
      if (rec.to) {
        await sendAsUser(admin, {
          userId: user.id, to: rec.to, subject: `${E.jobTitle(project)}: your quote is now due ${E.fmtDay(date)}`,
          bodyText: `Hi ${rec.first},\n\nWe need a little longer on your quote for ${E.jobTitle(project)}. It is now due ${E.fmtDay(date)}${was ? ` (it was ${E.fmtDay(was)})` : ''}.\n\n${reason}\n\nSorry for the wait.${await portalLine(admin, rec.to)}`,
          tagProjectId: project.id, tagKind: 'client',
        });
        emailed = true;
      }
      return json(200, { ok: true, emailed });
    }
    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('job-client-message failed:', err.message);
    return json(500, { ok: false, error: /not connected/.test(err.message) ? 'sales@ is not connected, so the email could not go.' : err.message });
  }
};
