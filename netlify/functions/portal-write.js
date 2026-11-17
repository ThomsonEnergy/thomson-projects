// POST /.netlify/functions/portal-write   (the device's portal token is the check, see
// _shared/portal-session.js). What a client may change from the portal (backlog item 74):
//   ask_date      { projectId, date: 'YYYY-MM-DD', time: 'HH:MM' | '', note }   ask for a day and
//                 time on a job of theirs (point 9a). Books nothing: the office books it and tells
//                 them the usual way, which closes the ask by itself (a database trigger). One open
//                 ask per job: a second one replaces the first. 5 asks an hour per device.
//   withdraw_ask  { projectId }                                               take the open ask back
//   request       { clientId, siteId | address, need, kind: 'quote' | 'book', dueDate, dates, files }
//                 ask for a quote (a draft Q with the date it is needed by) or for do and charge work
//                 to be booked in (a J with one to three suggested days); files are photos or PDFs
//   add_more      { projectId, note, files }   more on a draft quote they asked for, until it is sent
//   message       { projectId, body }          a message on the job's thread (the Feed tab)
//   add_person    { clientId, name, email }    the People card, a client's main email only: a portal
//   remove_person { clientId, contactId }      login for someone else at their company, or take it away
// Per login an hour (counted from the usage log, each try once, refused tries too): 5 requests,
// 10 add_more, 10 people changes, 20 messages; and 5 date asks per device.
// Every call checks the session and that the job is in the login's scope before anything is
// written. Writes portal_booking_requests, activity_log, notifications (create_notification) and
// the usage row (portal_events).

const S = require('./_shared/portal-session');
const D = require('./_shared/portal-data');
const { jobRef, fmtDay, fmtTime, sydneyToday, addDays } = require('./_shared/schedule-emails');
const R = require('./_shared/portal-requests');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const ASKS_PER_HOUR = 5;

// The site manager on the job, the ops managers and every active Admin, Finance and Sales person.
async function officeIds(admin, projectId) {
  const [{ data: contacts }, { data: settings }, { data: pricing }] = await Promise.all([
    admin.from('job_contacts').select('profile_id, role').eq('project_id', projectId).eq('side', 'thomson').in('role', ['site_manager', 'project_manager']),
    admin.from('company_settings').select('ops_manager_user_ids').eq('id', 1).maybeSingle(),
    admin.from('profiles').select('id').in('role', ['admin', 'finance', 'sales']).eq('active', true),
  ]);
  const managers = (settings && settings.ops_manager_user_ids) || [];
  const site = (contacts || []).map((c) => c.profile_id).filter(Boolean);
  // the job's own people and the ops managers; everyone in the office only when nobody is named
  const named = [...new Set([...site, ...managers])];
  return named.length ? named : (pricing || []).map((p) => p.id);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return S.json(400, { ok: false, error: 'Bad request' }); }
  const auth = await S.requirePortalSession(event);
  if (!auth) return S.json(401, { ok: false, error: 'Please log in again.' });
  if (auth.mustChange) return S.json(403, { ok: false, mustChange: true, error: 'Choose your password first.' });
  const { admin, scope, session, log } = auth;
  try {
    // the actions that are not about one existing job
    const since = new Date(Date.now() - 3600 * 1000).toISOString();
    // the usage log writes one row per client in the scope: count the first client's rows (or the
    // no-client rows of a job contact) so each try counts once. A try is logged before it runs, so a
    // refused or failed one still counts.
    const firstClient = scope.clients[0] ? scope.clients[0].id : null;
    const hourly = async (actions) => {
      let q = admin.from('portal_events').select('id', { count: 'exact', head: true }).eq('email', scope.email).in('action', actions).gte('created_at', since);
      q = firstClient ? q.eq('client_id', firstClient) : q.is('client_id', null);
      const { count } = await q;
      return count || 0;
    };
    const limited = async (action, max, detail) => {
      if ((await hourly([action])) >= max) return true;
      await log(action, detail || {});
      return false;
    };
    const TOO_MANY = S.json(429, { ok: false, error: 'That is a lot in an hour. Please call us instead.' });
    if (body.action === 'request') {
      if (await limited('portal_request', 5, { detail: String(body.kind || '') })) return TOO_MANY;
      const made = await R.createRequest(admin, scope, body);
      return S.json(200, { ok: true, ...made });
    }
    if (body.action === 'add_person' || body.action === 'remove_person') {
      const action = body.action === 'add_person' ? 'added_person' : 'removed_person';
      if (await limited(action, 10, { detail: String(body.email || body.contactId || '').slice(0, 80) })) return TOO_MANY;
      if (body.action === 'add_person') await R.addPerson(admin, scope, body); else await R.removePerson(admin, scope, body);
      return S.json(200, { ok: true, people: await R.peopleFor(admin, scope) });
    }

    const projectId = String(body.projectId || '');
    if (!UUID.test(projectId)) return S.json(400, { ok: false, error: 'Which job?' });
    const p = await D.scopedProject(admin, scope, projectId);
    if (!p) return S.json(404, { ok: false, error: 'That job is not on your account.' });
    if (body.action === 'add_more') {
      if (!p.money) return S.json(403, { ok: false, error: 'Only the client can add to a quote request.' });
      if (await limited('portal_request_more', 10, { projectId: p.id, detail: jobRef(p) })) return TOO_MANY;
      const r = await R.addToRequest(admin, scope, p, body);
      return S.json(200, { ok: true, ...r });
    }
    if (body.action === 'message') {
      if (await limited('portal_message', 20, { projectId: p.id, detail: jobRef(p) })) return TOO_MANY;
      await R.postClientMessage(admin, scope, p, body.body);
      return S.json(200, { ok: true });
    }
    if (!p.job_number) return S.json(404, { ok: false, error: 'That job is not on your account.' });
    const now = new Date().toISOString();

    if (body.action === 'withdraw_ask') {
      await admin.from('portal_booking_requests').update({ withdrawn_at: now }).eq('project_id', p.id).is('answered_at', null).is('withdrawn_at', null);
      await log('withdrew_date_ask', { projectId: p.id, detail: jobRef(p) });
      return S.json(200, { ok: true });
    }

    if (body.action === 'ask_date') {
      const date = String(body.date || '');
      const time = String(body.time || '');
      const note = String(body.note || '').trim().slice(0, 500) || null;
      if (!DATE.test(date) || date <= sydneyToday()) return S.json(400, { ok: false, error: 'Pick a day from tomorrow on.' });
      if (date > addDays(sydneyToday(), 365)) return S.json(400, { ok: false, error: 'Pick a day within the next year.' });
      if (time && (!TIME.test(time) || time < '07:00' || time > '16:00')) return S.json(400, { ok: false, error: 'Pick a start between 7 am and 4 pm, or Any time.' });
      const since = new Date(Date.now() - 3600 * 1000).toISOString();
      const { count } = await admin.from('portal_booking_requests').select('id', { count: 'exact', head: true }).eq('session_id', session.id).gte('created_at', since);
      if ((count || 0) >= ASKS_PER_HOUR) return S.json(429, { ok: false, error: 'That is a lot of asks in an hour. Please call us instead.' });

      // a new ask replaces the open one (Change on the page)
      await admin.from('portal_booking_requests').update({ withdrawn_at: now }).eq('project_id', p.id).is('answered_at', null).is('withdrawn_at', null);
      const { error } = await admin.from('portal_booking_requests').insert({ project_id: p.id, ask_date: date, ask_time: time || null, note, email: scope.email, session_id: session.id });
      if (error) throw error;

      const when = `${fmtDay(date)}${time ? `, ${fmtTime(time)}` : ', any time'}`;
      const who = scope.firstName || scope.email;
      await admin.from('activity_log').insert({ entity_type: 'project', entity_id: p.id, action: 'client_asked_date', description: `${who} asked for ${when} in the client portal${note ? `: "${note}"` : ''}` });
      for (const uid of await officeIds(admin, p.id)) {
        await admin.rpc('create_notification', {
          p_user: uid, p_kind: 'booking_reminder', p_title: `Client asked for a date: ${jobRef(p)} ${p.name || ''}`.trim(),
          p_body: `${who} asked for ${when}.${note ? ` "${note.slice(0, 120)}"` : ''} Book it from the job's Schedule tab.`,
          p_link: `/project.html?id=${p.id}&tab=schedule`, p_actor: null, p_dedupe: `portal-ask:${p.id}:${date}:${time}`,
        });
      }
      await log('asked_date', { projectId: p.id, detail: `${jobRef(p)} ${date}` });
      return S.json(200, { ok: true });
    }
    return S.json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    if (err.statusCode === 400) return S.json(400, { ok: false, error: err.message });
    console.error('portal-write failed:', err);
    return S.json(500, { ok: false, error: 'Something went wrong. Please try again.' });
  }
};
