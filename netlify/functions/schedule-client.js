// POST /.netlify/functions/schedule-client   (docs/PROJECT_SPEC.md A34)
// The job Schedule tab's server side. Any active staff member may read; Admin, Finance and Sales
// (the roles that may book, same as the schedule_assignments policy) may change things.
//   { action: 'recipient', projectId }                      who a client email goes to
//   { action: 'draft', projectId, kind, assignmentIds, move, offer }   the editable email text
//   { action: 'email_booking', projectId, assignmentIds, to, subject, body }
//        sends the booking to the client from sales@ in the sender's name, marks those bookings
//        client informed, records it in schedule_emails and the activity log.
//   { action: 'mark_informed', projectId, assignmentIds, how }   told by phone or in person
//   { action: 'move', projectId, assignmentIds, date, start, end, email, to, subject, body }
//        moves every one of those bookings to the new day and times; emails the client when
//        asked (and marks informed), otherwise clears client informed; tells the staff.
//   { action: 'cancel', projectId, assignmentIds, email, to, subject, body, offer }
//        deletes those bookings; emails the client when asked, with new time options when
//        `offer` is given (then the email carries the pick-a-time link); tells the staff.
//   { action: 'offer', projectId, staffIds, start, end, days, weekdaysOnly, optionDates, message, to, subject, body }
//        "Ask client to pick a time": saves the options and emails the private link.
//   { action: 'withdraw_offer', projectId, offerId }
// Every email goes through _shared/send-recorded-email.js so it shows on the job's Emails tab.

const { requireActiveUser } = require('./_shared/require-active-user');
const { sendAsUser } = require('./_shared/send-recorded-email');
const { publicBaseUrl } = require('./_shared/site-url');
const E = require('./_shared/schedule-emails');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const PRICING = ['admin', 'finance', 'sales'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const TIME = /^\d{2}:\d{2}(:\d{2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const hhmm = (t) => String(t).slice(0, 5);

class Refused extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }

async function loadProject(admin, projectId) {
  if (!UUID.test(projectId || '')) throw new Refused('Which job?');
  const { data: project } = await admin.from('projects').select('id, name, job_number, quote_number, client_name, client_email, client_address, job_contact_id').eq('id', projectId).maybeSingle();
  if (!project) throw new Refused('Job not found.', 404);
  return project;
}

// The bookings named, all on this job, in date order.
async function loadRows(admin, projectId, ids) {
  const list = (Array.isArray(ids) ? ids : []).filter((id) => UUID.test(id));
  if (!list.length) throw new Refused('Pick at least one booking.');
  const { data: rows } = await admin.from('schedule_assignments').select('id, staff_id, project_id, assignment_date, start_time, end_time, block_type, client_informed_at, profiles(full_name)')
    .eq('project_id', projectId).in('id', list).order('assignment_date').order('start_time');
  if (!rows || rows.length !== list.length) throw new Refused('Some of those bookings are no longer there. Reload the page.', 409);
  return rows;
}

function checkOffer(offer, today) {
  const o = offer || {};
  const staffIds = [...new Set((Array.isArray(o.staffIds) ? o.staffIds : []).filter((id) => UUID.test(id)))];
  if (!staffIds.length) throw new Refused('Pick at least one person for the options.');
  if (!TIME.test(o.start || '') || !TIME.test(o.end || '') || hhmm(o.end) <= hhmm(o.start)) throw new Refused('Finish time must be after the start time.');
  const days = Math.max(1, Math.min(10, parseInt(o.days, 10) || 1));
  const weekdaysOnly = o.weekdaysOnly !== false;
  const optionDates = [...new Set((Array.isArray(o.optionDates) ? o.optionDates : []).filter((d) => DATE.test(d)))].sort();
  if (optionDates.length < 1 || optionDates.length > 6) throw new Refused('Offer between 1 and 6 dates.');
  if (optionDates.some((d) => d < today)) throw new Refused('An option date is in the past.');
  const message = String(o.message || '').trim().slice(0, 1000) || null;
  return { staffIds, start: hhmm(o.start), end: hhmm(o.end), days, weekdaysOnly, optionDates, message };
}

async function draftFor(admin, project, body, user) {
  const kind = body.kind;
  const rec = await E.recipientFor(admin, project);
  const phone = await E.companyPhone(admin);
  const first = rec.first;
  let text = '';
  if (kind === 'booking_confirmed') {
    const rows = await loadRows(admin, project.id, body.assignmentIds);
    const who = await E.whoOn(admin, project.id, [...new Set(rows.map((r) => r.assignment_date))]);
    text = E.bookingConfirmedBody({ first, project, rows, who, phone });
  } else if (kind === 'booking_moved') {
    const rows = await loadRows(admin, project.id, body.assignmentIds);
    const m = body.move || {};
    if (!DATE.test(m.date || '') || !TIME.test(m.start || '') || !TIME.test(m.end || '')) throw new Refused('Pick the new day and times first.');
    const newRows = rows.map((r) => ({ assignment_date: m.date, start_time: m.start, end_time: m.end }));
    const who = [...new Set(rows.map((r) => r.profiles && r.profiles.full_name).filter(Boolean))].sort();
    text = E.bookingMovedBody({ first, project, oldRows: rows, newRows, who, phone });
  } else if (kind === 'booking_cancelled') {
    const rows = await loadRows(admin, project.id, body.assignmentIds);
    text = E.bookingCancelledBody({ first, project, oldRows: rows, phone, withOptions: !!body.offer });
  } else if (kind === 'time_offer') {
    const o = checkOffer(body.offer, E.sydneyToday());
    const who = await E.namesFor(admin, o.staffIds);
    text = E.timeOfferBody({ first, project, start: o.start, end: o.end, days: o.days, weekdaysOnly: o.weekdaysOnly, optionDatesList: o.optionDates, who, message: o.message, phone });
  } else throw new Refused('Unknown email kind.');
  return { to: rec.to, toName: rec.name, source: rec.source, subject: E.subjectFor(kind, project), body: text };
}

function cleanBody(body) {
  const text = String(body || '').replace(/—/g, ',').replace(/\r/g, '').trim();
  if (!text) throw new Refused('The email has no text.');
  if (text.length > 20000) throw new Refused('The email is too long.');
  // the pick-a-time button is added by the server, never typed in
  return text.split('\n').filter((l) => !/^\s*\[\[button:/i.test(l)).join('\n');
}
function cleanTo(to) {
  const addr = String(to || '').trim();
  if (!EMAIL.test(addr)) throw new Refused('That email address does not look right.');
  return addr;
}
function cleanSubject(subject, fallback) {
  return String(subject || '').replace(/—/g, ',').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || fallback;
}

async function log(admin, projectId, action, description, userId) {
  await admin.from('activity_log').insert({ entity_type: 'project', entity_id: projectId, action, description, changed_by: userId || null });
}

async function createOffer(admin, project, user, o, to, toName) {
  const { data: offer, error } = await admin.from('schedule_time_offers').insert({
    project_id: project.id, staff_ids: o.staffIds, start_time: o.start, end_time: o.end, days: o.days, weekdays_only: o.weekdaysOnly,
    option_dates: o.optionDates, message: o.message, to_email: to, to_name: toName || null, created_by: user.id,
  }).select('*').single();
  if (error) throw error;
  return offer;
}
const offerUrl = (offer) => `${publicBaseUrl()}/pick-time.html?token=${offer.token}`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(403, { ok: false, error: 'Not signed in.' });
  const { supabaseAdmin: admin, user, role } = auth;
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Bad request.' }); }
  const action = String(body.action || '');
  const today = E.sydneyToday();

  try {
    const project = await loadProject(admin, body.projectId);

    if (action === 'recipient') {
      const rec = await E.recipientFor(admin, project);
      return json(200, { ok: true, to: rec.to, name: rec.name, source: rec.source });
    }
    if (action === 'draft') return json(200, { ok: true, ...(await draftFor(admin, project, body, user)) });

    if (!PRICING.includes(role)) return json(403, { ok: false, error: 'Only Admin, Finance or Sales can change bookings.' });

    if (action === 'email_booking') {
      const rows = await loadRows(admin, project.id, body.assignmentIds);
      const to = cleanTo(body.to);
      const subject = cleanSubject(body.subject, E.subjectFor('booking_confirmed', project));
      const text = cleanBody(body.body);
      const sent = await sendAsUser(admin, { userId: user.id, to, subject, bodyText: text, tagProjectId: project.id, tagKind: 'client' });
      const ids = rows.map((r) => r.id);
      await admin.from('schedule_assignments').update({ client_informed_at: new Date().toISOString(), client_informed_email_id: sent.emailId }).in('id', ids);
      await admin.from('schedule_emails').insert({ project_id: project.id, kind: 'booking_confirmed', to_email: to, subject: sent.subject, email_id: sent.emailId, thread_id: sent.thread.id, assignment_ids: ids, sent_by: user.id });
      await log(admin, project.id, 'booking_client_informed', `Booking emailed to the client (${to}): ${E.whenLines(rows).join('; ')}`, user.id);
      return json(200, { ok: true, threadId: sent.thread.id });
    }

    if (action === 'mark_informed') {
      const rows = await loadRows(admin, project.id, body.assignmentIds);
      const how = body.how === 'in_person' ? 'in person' : 'by phone';
      await admin.from('schedule_assignments').update({ client_informed_at: new Date().toISOString(), client_informed_email_id: null }).in('id', rows.map((r) => r.id));
      await log(admin, project.id, 'booking_client_informed', `Client told ${how}: ${E.whenLines(rows).join('; ')}`, user.id);
      return json(200, { ok: true });
    }

    if (action === 'move') {
      const rows = await loadRows(admin, project.id, body.assignmentIds);
      if (!DATE.test(body.date || '') || body.date < today) throw new Refused('Pick a day from today on.');
      if (!TIME.test(body.start || '') || !TIME.test(body.end || '') || hhmm(body.end) <= hhmm(body.start)) throw new Refused('Finish time must be after the start time.');
      const patch = { assignment_date: body.date, start_time: hhmm(body.start), end_time: hhmm(body.end) };
      const ids = rows.map((r) => r.id);
      const wasInformed = rows.some((r) => r.client_informed_at);
      let sent = null;
      let to = null;
      if (body.email) {
        to = cleanTo(body.to);
        const subject = cleanSubject(body.subject, E.subjectFor('booking_moved', project));
        sent = await sendAsUser(admin, { userId: user.id, to, subject, bodyText: cleanBody(body.body), tagProjectId: project.id, tagKind: 'client' });
        Object.assign(patch, { client_informed_at: new Date().toISOString(), client_informed_email_id: sent.emailId });
      } else {
        // the client was told the old time: it is tentative again until they hear the new one
        Object.assign(patch, { client_informed_at: null, client_informed_email_id: null });
      }
      const { error } = await admin.from('schedule_assignments').update(patch).in('id', ids);
      if (error) throw error;
      const newRows = rows.map((r) => ({ ...r, ...patch }));
      if (sent) await admin.from('schedule_emails').insert({ project_id: project.id, kind: 'booking_moved', to_email: to, subject: sent.subject, email_id: sent.emailId, thread_id: sent.thread.id, assignment_ids: ids, sent_by: user.id });
      await E.notifyStaff(admin, rows, { title: `Booking moved: ${E.jobTitle(project)}`, body: `Now ${E.whenLines(newRows).join('; ')} (was ${E.whenLines(rows).join('; ')})`, actorId: user.id });
      await log(admin, project.id, 'booking_moved', `Booking moved to ${E.whenLines(newRows).join('; ')} (was ${E.whenLines(rows).join('; ')})${sent ? `, client emailed (${to})` : wasInformed ? ', client not yet told' : ''}`, user.id);
      return json(200, { ok: true });
    }

    if (action === 'cancel') {
      const rows = await loadRows(admin, project.id, body.assignmentIds);
      const ids = rows.map((r) => r.id);
      let offer = null;
      let sent = null;
      let to = null;
      if (body.email) {
        to = cleanTo(body.to);
        let text = cleanBody(body.body);
        if (body.offer) {
          const o = checkOffer(body.offer, today);
          offer = await createOffer(admin, project, user, o, to, body.toName);
          const who = await E.namesFor(admin, o.staffIds);
          text += `\n\nOptions (${E.fmtTime(o.start)} to ${E.fmtTime(o.end)}${o.days > 1 ? `, ${o.days} days` : ''}):\n${o.optionDates.map((d) => `- ${E.optionLabel(d, o.days, o.weekdaysOnly)}`).join('\n')}${who.length ? `\n${E.listNames(who)} would be doing the work.` : ''}\n\n[[button: Pick a time that suits you | ${offerUrl(offer)}]]`;
        }
        const subject = cleanSubject(body.subject, E.subjectFor('booking_cancelled', project));
        sent = await sendAsUser(admin, { userId: user.id, to, subject, bodyText: text, tagProjectId: project.id, tagKind: 'client' });
        if (offer) await admin.from('schedule_time_offers').update({ email_id: sent.emailId }).eq('id', offer.id);
      }
      const { error } = await admin.from('schedule_assignments').delete().in('id', ids);
      if (error) throw error;
      if (sent) await admin.from('schedule_emails').insert({ project_id: project.id, kind: offer ? 'time_offer' : 'booking_cancelled', to_email: to, subject: sent.subject, email_id: sent.emailId, thread_id: sent.thread.id, assignment_ids: ids, offer_id: offer ? offer.id : null, sent_by: user.id });
      await E.notifyStaff(admin, rows, { title: `Booking cancelled: ${E.jobTitle(project)}`, body: E.whenLines(rows).join('; '), actorId: user.id });
      await log(admin, project.id, 'booking_cancelled', `Booking cancelled: ${E.whenLines(rows).join('; ')}${sent ? `, client emailed (${to})${offer ? ' with new time options' : ''}` : ''}`, user.id);
      return json(200, { ok: true, offerId: offer ? offer.id : null });
    }

    if (action === 'offer') {
      const o = checkOffer(body.offer || body, today);
      const to = cleanTo(body.to);
      const offer = await createOffer(admin, project, user, o, to, body.toName);
      const text = `${cleanBody(body.body)}\n\n[[button: Pick a time that suits you | ${offerUrl(offer)}]]`;
      const subject = cleanSubject(body.subject, E.subjectFor('time_offer', project));
      let sent;
      try {
        sent = await sendAsUser(admin, { userId: user.id, to, subject, bodyText: text, tagProjectId: project.id, tagKind: 'client' });
      } catch (err) {
        await admin.from('schedule_time_offers').delete().eq('id', offer.id); // not sent, so not open
        throw err;
      }
      await admin.from('schedule_time_offers').update({ email_id: sent.emailId }).eq('id', offer.id);
      await admin.from('schedule_emails').insert({ project_id: project.id, kind: 'time_offer', to_email: to, subject: sent.subject, email_id: sent.emailId, thread_id: sent.thread.id, offer_id: offer.id, sent_by: user.id });
      await log(admin, project.id, 'time_offer_sent', `Time options sent to the client (${to}): ${o.optionDates.map((d) => E.optionLabel(d, o.days, o.weekdaysOnly)).join(', ')}`, user.id);
      return json(200, { ok: true, offerId: offer.id, url: offerUrl(offer) });
    }

    if (action === 'withdraw_offer') {
      if (!UUID.test(body.offerId || '')) throw new Refused('Which options?');
      const { data: offer } = await admin.from('schedule_time_offers').update({ status: 'withdrawn' }).eq('id', body.offerId).eq('project_id', project.id).eq('status', 'open').select('id').maybeSingle();
      if (!offer) throw new Refused('Those options are not open any more.', 409);
      await log(admin, project.id, 'time_offer_withdrawn', 'Time options withdrawn (the link no longer works)', user.id);
      return json(200, { ok: true });
    }

    return json(400, { ok: false, error: 'Unknown action.' });
  } catch (err) {
    if (err instanceof Refused) return json(err.code, { ok: false, error: err.message });
    console.error('schedule-client failed:', err);
    return json(500, { ok: false, error: err.message || 'Something went wrong.' });
  }
};
