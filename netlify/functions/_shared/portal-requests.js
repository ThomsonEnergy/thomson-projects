// Client portal requests and messages (backlog item 74 points 1, 8 and 9). Called by portal-write.js
// (the client, after the session and scope checks) and job-client-message.js (staff). Plain inputs,
// plain results; throws Refused (statusCode 400) with a message the client can read.
//
//   requestOptions(admin, scope)            the request form: each client of the login with its saved
//                                            sites and whether Book it in is offered
//   createRequest(admin, scope, input)       Quote it (a draft quote with the date they need it by) or
//                                            Book it in (a do and charge job with suggested days);
//                                            files go in a "From client" folder they can see;
//                                            or Disconnect and reconnect (item 109): a price list
//                                            job with the booking questions answered, any client
//   addToRequest(admin, scope, p, input)     more words and files on a draft quote they asked for
//   saveClientFiles(admin, projectId, files, email)
//   postClientMessage(admin, scope, p, body) a message from the client on a job's thread
//   peopleFor(admin, scope) / addPerson / removePerson   the People card (a client's main email only)
// Writes projects, cost_centres, client_sites, project_documents (and storage), job_client_messages,
// client_contacts, activity_log, notifications.

const { addressColumns } = require('./address-parts');
const crypto = require('crypto');
const { sydneyToday, addDays, fmtDay, jobRef } = require('./schedule-emails');
const { sendPortalInvite } = require('./portal-invite');

class Refused extends Error { constructor(msg) { super(msg); this.statusCode = 400; } }

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // all files together: the function body limit is 6 MB, and base64 adds a third
const OK_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
const clean = (s, n) => String(s || '').trim().slice(0, n);

// The office: ops managers, plus every active Admin, Finance and Sales person.
async function officeIds(admin) {
  const [{ data: settings }, { data: pricing }] = await Promise.all([
    admin.from('company_settings').select('ops_manager_user_ids').eq('id', 1).maybeSingle(),
    admin.from('profiles').select('id').in('role', ['admin', 'finance', 'sales']).eq('active', true),
  ]);
  return [...new Set([...((settings && settings.ops_manager_user_ids) || []), ...(pricing || []).map((p) => p.id)])];
}
async function tellOffice(admin, ids, { title, body, link, dedupe }) {
  for (const uid of ids) await admin.rpc('create_notification', { p_user: uid, p_kind: 'booking_reminder', p_title: title, p_body: body, p_link: link, p_actor: null, p_dedupe: dedupe });
}
// The job's own people (site and project manager), else the office.
async function jobPeople(admin, projectId) {
  const { data } = await admin.from('job_contacts').select('profile_id').eq('project_id', projectId).eq('side', 'thomson').in('role', ['site_manager', 'project_manager']);
  const named = [...new Set((data || []).map((c) => c.profile_id).filter(Boolean))];
  return named.length ? named : officeIds(admin);
}

// Book it in is for clients we already do do and charge work for: a commercial agreement, or a
// do and charge job on record.
async function canBookIn(admin, clientId) {
  const [{ data: cl }, { count }] = await Promise.all([
    admin.from('clients').select('agreement_sent_at, agreement_withdrawn_at').eq('id', clientId).maybeSingle(),
    admin.from('projects').select('id', { count: 'exact', head: true }).eq('client_id', clientId).eq('proposal_template', 'direct_job'),
  ]);
  return !!(cl && cl.agreement_sent_at && !cl.agreement_withdrawn_at) || (count || 0) > 0;
}

async function requestOptions(admin, scope) {
  const clients = [];
  for (const c of scope.clients) {
    const { data: sites } = await admin.from('client_sites').select('id, label, address').eq('client_id', c.id).order('created_at');
    clients.push({ id: c.id, name: c.name, sites: (sites || []).map((s) => ({ id: s.id, label: s.label || '', address: s.address })), bookIn: await canBookIn(admin, c.id) });
  }
  // Disconnect and reconnect (item 109) is offered to every client: its booking questions and the price list link
  const { data: s } = await admin.from('company_settings').select('service_booking_questions, service_prices_token').eq('id', 1).maybeSingle();
  const anyShown = await admin.from('service_price_items').select('prebuild_id', { count: 'exact', head: true }).eq('shown', true);
  const service = s && (anyShown.count || 0) > 0 ? { questions: s.service_booking_questions || [], pricesUrl: `/service-prices.html?token=${s.service_prices_token}` } : null;
  return { clients, service };
}

// files: [{ name, type, data (base64, no prefix) }]. Saved under the project, visible to the client.
// Every file is checked before anything is written (a bad one refuses the whole request, so a
// refused request never leaves a project or a file behind). Returns the decoded files.
function checkFiles(files) {
  const list = Array.isArray(files) ? files : [];
  if (list.length > MAX_FILES) throw new Refused(`Up to ${MAX_FILES} files, please.`);
  let total = 0;
  return list.map((f) => {
    const type = String(f.type || '').toLowerCase();
    if (!OK_MIME.test(type)) throw new Refused('Photos (JPG, PNG, HEIC) and PDFs only, please.');
    const bytes = Buffer.from(String(f.data || ''), 'base64');
    total += bytes.length;
    if (!bytes.length) throw new Refused('One of the files is empty.');
    if (total > MAX_TOTAL_BYTES) throw new Refused('The files come to more than 4 MB. Send fewer, or smaller ones.');
    return { type, bytes, name: clean(f.name, 120).replace(/[^a-zA-Z0-9._ -]/g, '_') || 'file' };
  });
}

// checked: the result of checkFiles
async function saveClientFiles(admin, projectId, checked, email) {
  const saved = [];
  for (const { type, bytes, name } of checked) {
    const path = `${projectId}/from-client/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${name.replace(/\s+/g, '_')}`;
    const { error: upErr } = await admin.storage.from('project-documents').upload(path, bytes, { contentType: type, upsert: false });
    if (upErr) throw upErr;
    const { error } = await admin.from('project_documents').insert({ project_id: projectId, folder: 'From client', file_path: path, file_name: name, mime_type: type, client_visible: true });
    if (error) throw error;
    saved.push(name);
  }
  if (saved.length) await admin.from('activity_log').insert({ entity_type: 'project', entity_id: projectId, action: 'client_files', description: `${email} added ${saved.length} file${saved.length === 1 ? '' : 's'} in the client portal: ${saved.join(', ')}` });
  return saved;
}

// input: { clientId, siteId | address, need, kind: 'quote' | 'book', dueDate, dates: [], files }
async function createRequest(admin, scope, input) {
  const client = scope.clients.find((c) => c.id === input.clientId) || (scope.clients.length === 1 ? scope.clients[0] : null);
  if (!client) throw new Refused('Pick which company this is for.');
  const kind = input.kind === 'book' ? 'book' : input.kind === 'service' ? 'service' : 'quote';
  const need = clean(input.need, 4000) || (kind === 'service' ? 'Disconnect and reconnect' : '');
  if (need.length < 5) throw new Refused('Tell us what you need.');
  const today = sydneyToday();
  const checked = checkFiles(input.files);

  // the site: one of theirs, or a new address saved as a site
  let site = null;
  if (input.siteId) {
    const { data } = await admin.from('client_sites').select('id, address, address_parts, lat, lng').eq('id', input.siteId).eq('client_id', client.id).maybeSingle();
    if (!data) throw new Refused('Pick one of your sites, or type the address.');
    site = data;
  } else {
    const address = clean(input.address, 300);
    if (address.length < 6) throw new Refused('Type the site address.');
    // the same match as the unique index (lower case, trimmed)
    const norm = (a) => String(a || '').trim().toLowerCase();
    const { data: sites } = await admin.from('client_sites').select('id, address, address_parts, lat, lng').eq('client_id', client.id);
    const same = (sites || []).find((x) => norm(x.address) === norm(address));
    if (same) site = same;
    else {
      // the address in parts from Google's lookup on the portal's address box (item 103), when it came
      const { data: made, error } = await admin.from('client_sites').insert({ client_id: client.id, address, created_by: null, ...addressColumns(input.addressParts, address) }).select('id, address, address_parts, lat, lng').single();
      if (error) throw error;
      site = made;
    }
  }

  const { data: cl } = await admin.from('clients').select('id, name, email, phone').eq('id', client.id).single();
  const { data: settings } = await admin.from('company_settings').select('default_terms, default_markup_percent').eq('id', 1).maybeSingle();
  const name = (kind === 'service' ? `Disconnect and reconnect: ${site.address}` : need.split(/\n/)[0]).slice(0, 80);
  const base = {
    // the client's own email; a portal login's when the client has none (never a label like "their referral link")
    name, client_id: cl.id, client_name: cl.name, client_email: cl.email || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(scope.email) ? scope.email : null), client_phone: cl.phone || null,
    client_address: site.address, client_site_id: site.id, ...(site.address_parts ? { address_parts: site.address_parts, lat: site.lat, lng: site.lng } : {}), portal_requested_at: new Date().toISOString(), portal_requested_by: scope.email,
  };

  let project;
  if (kind === 'quote') {
    const due = String(input.dueDate || '');
    if (!DATE.test(due) || due < addDays(today, 1)) throw new Refused('Pick the date you need the quote by, from tomorrow on.');
    const { data: number, error: nErr } = await admin.rpc('get_next_number_serverside', { counter_name: 'quote' });
    if (nErr) throw nErr;
    const { data, error } = await admin.from('projects').insert({
      ...base, quote_number: number, notes: need, sow_brief: need, terms_text: (settings && settings.default_terms) || '',
      proposal_template: 'service_work', pipeline_stage: 'draft_quote', status: 'draft', client_due_date: due,
    }).select('id, name, quote_number, job_number').single();
    if (error) throw error;
    project = data;
  } else if (kind === 'service') {
    // Disconnect and reconnect at the price list (item 109): a do and charge job set up as a price list
    // job, with their answers to the booking questions. The day the panels come off is the day they ask for.
    const service = require('./service-jobs');
    const off = String((input.booking || {}).roof_off_date || '');
    if (!DATE.test(off) || off <= today) throw new Refused('Pick the day the panels need to come off, from tomorrow on.');
    const { data, error } = await admin.from('projects').insert({
      ...base, sow_text: need, proposal_template: 'direct_job', pipeline_stage: 'ready_to_book', status: 'in_progress', client_suggested_dates: [off],
    }).select('id, name, quote_number, job_number').single();
    if (error) throw error;
    project = data;
    try {
      await service.setupServiceJob(admin, project.id, null);
      await service.saveBooking(admin, project.id, input.booking, `${scope.email} in the client portal`);
    } catch (err) {
      await admin.from('projects').delete().eq('id', project.id); // a refused answer leaves no half made job behind
      if (err.statusCode === 400) throw new Refused(err.message);
      throw err;
    }
  } else {
    if (!(await canBookIn(admin, cl.id))) throw new Refused('Book it in is for clients with a commercial agreement. Ask for a quote instead.');
    const dates = [...new Set((Array.isArray(input.dates) ? input.dates : []).filter((d) => DATE.test(d) && d > today))].sort().slice(0, 3);
    if (!dates.length) throw new Refused('Suggest at least one day from tomorrow on.');
    const { data, error } = await admin.from('projects').insert({
      ...base, sow_text: need, proposal_template: 'direct_job', pipeline_stage: 'ready_to_book', status: 'in_progress', client_suggested_dates: dates,
    }).select('id, name, quote_number, job_number').single();
    if (error) throw error;
    project = data;
    const { error: ccErr } = await admin.from('cost_centres').insert({ project_id: project.id, name: 'Labour & Materials', sort_order: 0, markup_percent: Number(settings && settings.default_markup_percent) || 45 });
    if (ccErr) throw ccErr;
  }

  const files = await saveClientFiles(admin, project.id, checked, scope.email);
  const ref = jobRef(project);
  const { data: madeRow } = await admin.from('projects').select('client_suggested_dates').eq('id', project.id).single();
  const what = kind === 'quote' ? `a quote, needed by ${fmtDay(input.dueDate)}` : `${kind === 'service' ? 'a disconnect and reconnect' : 'work'} booked in on ${((madeRow && madeRow.client_suggested_dates) || []).map(fmtDay).join(' or ')}`;
  await admin.from('activity_log').insert({ entity_type: 'project', entity_id: project.id, action: 'portal_request', description: `${scope.email} asked for ${what} in the client portal${files.length ? `, with ${files.length} file${files.length === 1 ? '' : 's'}` : ''}` });
  await tellOffice(admin, await officeIds(admin), {
    title: `New from the client portal: ${ref} ${project.name}`,
    body: `${cl.name} (${scope.email}) asked for ${what}. ${site.address}`,
    link: `/project.html?id=${project.id}${kind === 'quote' ? '&tab=quote' : '&tab=schedule'}`, dedupe: `portal-request:${project.id}`,
  });
  return { id: project.id, ref, kind };
}

// More on a draft quote they asked for. Never changes our wording: their words go on the notes.
async function addToRequest(admin, scope, p, input) {
  if (p.job_number || p.sent_at || !p.portal_requested_at) throw new Refused('You can add to a request until we send the quote.');
  const more = clean(input.note, 4000);
  const files = await saveClientFiles(admin, p.id, checkFiles(input.files), scope.email);
  if (!more && !files.length) throw new Refused('Add a note or a file.');
  if (more) {
    const { data: cur } = await admin.from('projects').select('notes').eq('id', p.id).single();
    const stamped = `${(cur && cur.notes) || ''}\n\nAdded by ${scope.email} on ${fmtDay(sydneyToday())}:\n${more}`.trim();
    await admin.from('projects').update({ notes: stamped }).eq('id', p.id);
    await admin.from('activity_log').insert({ entity_type: 'project', entity_id: p.id, action: 'portal_request_more', description: `${scope.email} added to the request in the client portal: "${more.slice(0, 200)}"` });
  }
  await tellOffice(admin, await jobPeople(admin, p.id), { title: `Client added to ${jobRef(p)} ${p.name || ''}`.trim(), body: `${scope.email} added ${[more ? 'a note' : '', files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')}.`, link: `/project.html?id=${p.id}&tab=quote`, dedupe: `portal-more:${p.id}:${Date.now()}` });
  return { files: files.length, note: !!more };
}

async function postClientMessage(admin, scope, p, body) {
  // the thread is between us and the client (it talks about prices and invoices), never a job contact
  if (!p.money) throw new Refused('Messages are for the client on this job. Please call us instead.');
  const text = clean(body, 4000);
  if (!text) throw new Refused('Write a message first.');
  const { error } = await admin.from('job_client_messages').insert({ project_id: p.id, from_email: scope.email, body: text });
  if (error) throw error;
  await admin.from('activity_log').insert({ entity_type: 'project', entity_id: p.id, action: 'client_message', description: `${scope.email} wrote in the client portal: "${text.slice(0, 200)}"` });
  await tellOffice(admin, await jobPeople(admin, p.id), { title: `Message from the client: ${jobRef(p)} ${p.name || ''}`.trim(), body: `${scope.firstName || scope.email}: ${text.slice(0, 160)}`, link: `/project.html?id=${p.id}&tab=feed`, dedupe: `portal-msg:${p.id}:${Date.now()}` });
}

// ----- the People card: a client's main email lets others in -----
async function contactRows(admin, clientId, email) {
  const { data } = await admin.from('client_contacts').select('id, email').eq('client_id', clientId).not('email', 'is', null);
  const em = String(email).trim().toLowerCase();
  return (data || []).filter((x) => String(x.email).trim().toLowerCase() === em);
}
const mainClients = (scope) => scope.clients.filter((c) => c.main);
async function peopleFor(admin, scope) {
  const out = [];
  for (const c of mainClients(scope)) {
    const { data: cl } = await admin.from('clients').select('email').eq('id', c.id).maybeSingle();
    const { data: contacts } = await admin.from('client_contacts').select('id, name, email').eq('client_id', c.id).eq('portal_access', true).order('sort_order');
    out.push({ clientId: c.id, clientName: c.name, main: (cl && cl.email) || '', people: (contacts || []).filter((x) => x.email).map((x) => ({ id: x.id, name: x.name || '', email: x.email })) });
  }
  return out;
}
async function addPerson(admin, scope, { clientId, name, email }) {
  const c = mainClients(scope).find((x) => x.id === clientId);
  if (!c) throw new Refused('Only the main email on the account can add people.');
  const em = String(email || '').trim().toLowerCase();
  if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(em)) throw new Refused('That is not an email address.');
  // a staff login is never made a client contact (checked before anything is written)
  const { portalScope } = require('./portal-session');
  if ((await portalScope(admin, em)).staffUser) throw new Refused('That is a Thomson Energy staff email, not one of yours.');
  const same = await contactRows(admin, c.id, em);
  if (same.length) await admin.from('client_contacts').update({ portal_access: true }).in('id', same.map((x) => x.id));
  else {
    const { error } = await admin.from('client_contacts').insert({ client_id: c.id, contact_type: 'job', name: clean(name, 120) || null, email: em, portal_access: true });
    if (error) throw error;
  }
  await admin.from('activity_log').insert({ entity_type: 'client', entity_id: c.id, action: 'portal_person_added', description: `${scope.email} gave ${em} a portal login` });
  try { await sendPortalInvite(admin, em, { actorLabel: `added by ${scope.email}` }); } catch (e) { if (e.statusCode === 400) throw new Refused(e.message); throw e; }
}
async function removePerson(admin, scope, { clientId, contactId }) {
  const c = mainClients(scope).find((x) => x.id === clientId);
  if (!c) throw new Refused('Only the main email on the account can remove people.');
  const { data: row } = await admin.from('client_contacts').select('id, email').eq('id', contactId).eq('client_id', c.id).maybeSingle();
  if (!row) throw new Refused('That person is not on your account.');
  // every row with that email on this client (staff sometimes save one person as two contacts)
  const same = row.email ? await contactRows(admin, c.id, row.email) : [row];
  await admin.from('client_contacts').update({ portal_access: false }).in('id', same.map((x) => x.id));
  // no session to end: every portal call works the scope out fresh, so this client is gone from it at once
  await admin.from('activity_log').insert({ entity_type: 'client', entity_id: c.id, action: 'portal_person_removed', description: `${scope.email} took ${row.email}'s portal login away` });
}

module.exports = { Refused, requestOptions, createRequest, addToRequest, postClientMessage, peopleFor, addPerson, removePerson, officeIds };
