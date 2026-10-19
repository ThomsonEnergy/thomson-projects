// POST /.netlify/functions/pick-time   (public, the private link is the check)
//   { token, date }                      the client picked an option: books every person for every
//                                        day of it, all or nothing (book_time_offer in the database),
//                                        confirms by email, tells whoever sent the options.
//   { token, decline: true, message }    none of the options work: the office is told.
// Replies: { ok: true, booked: [...] }, { ok: true, declined: true }, or { ok: false, error, taken: true }
// when someone was booked in the meantime (the page greys that option out and asks again).

const { getAdminClient } = require('./_shared/require-admin');
const { sendAsUser } = require('./_shared/send-recorded-email');
const E = require('./_shared/schedule-emails');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

async function senderFor(admin, offer) {
  if (offer.created_by) {
    const { data: p } = await admin.from('profiles').select('id').eq('id', offer.created_by).eq('active', true).maybeSingle();
    if (p) return p.id;
  }
  const { data: a } = await admin.from('profiles').select('id').eq('role', 'admin').eq('active', true).order('created_at').limit(1).maybeSingle();
  return a ? a.id : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Bad request.' }); }
  const token = String(body.token || '');
  if (!UUID.test(token)) return json(404, { ok: false, error: 'This link is not valid.' });
  try {
    const admin = getAdminClient();
    const { data: offer } = await admin.from('schedule_time_offers').select('*').eq('token', token).maybeSingle();
    if (!offer) return json(404, { ok: false, error: 'This link is not valid.' });
    if (offer.status !== 'open') return json(409, { ok: false, error: 'These options are no longer open. Please contact us.' });
    const { data: project } = await admin.from('projects').select('id, name, job_number, quote_number, client_name, client_address').eq('id', offer.project_id).maybeSingle();
    if (!project) return json(404, { ok: false, error: 'This link is not valid.' });
    const link = `/project.html?id=${project.id}&tab=schedule`;

    if (body.decline) {
      const message = String(body.message || '').replace(/—/g, ',').trim().slice(0, 1000);
      const { data: upd } = await admin.from('schedule_time_offers').update({ status: 'declined', client_message: message || null }).eq('id', offer.id).eq('status', 'open').select('id').maybeSingle();
      if (!upd) return json(409, { ok: false, error: 'These options are no longer open. Please contact us.' });
      await admin.from('activity_log').insert({ entity_type: 'project', entity_id: project.id, action: 'time_offer_declined', description: `Client: none of the offered times work${message ? `. "${message}"` : ''}`, changed_by: null });
      if (offer.created_by) {
        await admin.rpc('create_notification', {
          p_user: offer.created_by, p_kind: 'booking_reminder', p_title: `None of the times suit: ${E.jobTitle(project)}`,
          p_body: message || `${offer.to_name || project.client_name || 'The client'} said none of the options work. Offer new ones or call them.`,
          p_link: link, p_actor: null, p_dedupe: `offer-declined:${offer.id}`,
        });
      }
      return json(200, { ok: true, declined: true });
    }

    const date = String(body.date || '');
    if (!DATE.test(date)) return json(400, { ok: false, error: 'Pick one of the dates.' });
    const { data: booked, error } = await admin.rpc('book_time_offer', { p_offer_id: offer.id, p_date: date });
    if (error) {
      const m = String(error.message || '');
      if (/taken/.test(m)) return json(409, { ok: false, taken: true, error: 'Sorry, that time was taken just now. Please pick another.' });
      if (/not_open/.test(m)) return json(409, { ok: false, error: 'These options are no longer open. Please contact us.' });
      if (/not_an_option|in_the_past/.test(m)) return json(400, { ok: false, error: 'Pick one of the dates shown.' });
      throw error;
    }
    const ids = booked.assignment_ids || [];
    const dates = booked.dates || [];
    const rows = dates.map((d) => ({ assignment_date: d, start_time: offer.start_time, end_time: offer.end_time }));
    const who = await E.whoOn(admin, project.id, dates);
    const phone = await E.companyPhone(admin);

    // the confirmation, in the name of whoever sent the options (their signature), kept on the job
    const senderId = await senderFor(admin, offer);
    if (senderId) {
      try {
        const text = E.timeOfferPickedBody({ first: E.firstName(offer.to_name || project.client_name), project, rows, who, phone });
        const sent = await sendAsUser(admin, { userId: senderId, to: offer.to_email, subject: E.subjectFor('time_offer_picked', project), bodyText: text, tagProjectId: project.id, tagKind: 'client' });
        await admin.from('schedule_assignments').update({ client_informed_email_id: sent.emailId }).in('id', ids);
        await admin.from('schedule_emails').insert({ project_id: project.id, kind: 'time_offer_picked', to_email: offer.to_email, subject: sent.subject, email_id: sent.emailId, thread_id: sent.thread.id, assignment_ids: ids, offer_id: offer.id, sent_by: senderId });
      } catch (err) { console.error('pick-time: confirmation email failed:', err.message); }
    }
    await admin.from('activity_log').insert({ entity_type: 'project', entity_id: project.id, action: 'time_offer_picked', description: `Client picked ${E.whenLines(rows).join('; ')} (${who.join(', ') || 'no one'} booked)`, changed_by: null });
    if (offer.created_by) {
      await admin.rpc('create_notification', {
        p_user: offer.created_by, p_kind: 'booking_reminder', p_title: `Client picked a time: ${E.jobTitle(project)}`,
        p_body: `${E.whenLines(rows).join('; ')}. ${who.length ? `${E.listNames(who)} booked.` : ''}`.trim(),
        p_link: link, p_actor: null, p_dedupe: `offer-picked:${offer.id}`,
      });
    }
    return json(200, { ok: true, booked: rows.map((r) => ({ date: r.assignment_date })), label: E.whenLines(rows).join('; ') });
  } catch (err) {
    console.error('pick-time failed:', err);
    return json(500, { ok: false, error: 'Something went wrong. Please try again or contact us.' });
  }
};
