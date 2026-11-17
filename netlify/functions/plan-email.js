// POST /.netlify/functions/plan-email   (backlog item 92, the job plan)
// Admin, Finance and Sales only. Telling the client a job's dates from the Plan view:
//   { action: 'draft', projectId }                       the editable email: a first confirmation,
//                                                        or a change when the job moved past the
//                                                        dates the client was told
//   { action: 'send', projectId, to, subject, body }     sends it from sales@ in the sender's name
//                                                        (recorded on the job), then saves the dates
//                                                        as the ones the client was told
//   { action: 'told', projectId }                        told by phone: saves the dates the same way
// The dates and the wording come from _shared/job-plan.js. Writes job_windows, job_tasks and
// activity_log through it, and the email tables through _shared/send-recorded-email.js.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { sendAsUser } = require('./_shared/send-recorded-email');
const { draftClientEmail, markClientTold } = require('./_shared/job-plan');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin: admin, user } = auth;
  try {
    const body = JSON.parse(event.body || '{}');
    if (!UUID.test(body.projectId || '')) return json(400, { ok: false, error: 'Which job?' });
    if (body.action === 'draft') return json(200, { ok: true, draft: await draftClientEmail(admin, body.projectId) });
    if (body.action === 'told') {
      const { span } = await markClientTold(admin, { projectId: body.projectId, userId: user.id, how: 'phone' });
      return json(200, { ok: true, span });
    }
    if (body.action === 'send') {
      const to = String(body.to || '').trim();
      const subject = String(body.subject || '').trim().slice(0, 200);
      const text = String(body.body || '').trim();
      if (!EMAIL.test(to)) return json(400, { ok: false, error: 'Add the client\'s email address.' });
      if (!subject || !text) return json(400, { ok: false, error: 'The email needs a subject and some text.' });
      await draftClientEmail(admin, body.projectId); // refuses a job with no dates before anything is sent
      await sendAsUser(admin, { userId: user.id, to, subject, bodyText: text, tagProjectId: body.projectId, tagKind: 'client' });
      const { span } = await markClientTold(admin, { projectId: body.projectId, userId: user.id, how: 'email' });
      return json(200, { ok: true, span });
    }
    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('plan-email failed:', err.message);
    return json(err.statusCode || 500, { ok: false, error: err.message });
  }
};
