// The referral link (backlog item 74b, step 3a: no money). A client's private link
// refer.html?r=<clients.referral_token> sends us work with no login: the link only ever sends a lead
// in that client's name and reads nothing back but the client's name and the reward amounts.
// Called by refer.js (public, the token is the check), portal-read.js (the referrer's rows) and
// client-referral.js (staff: the link, Regenerate, Send link).
// A staff member's personal link (item 74b 7a) is refer.html?s=<staff_referral_links.token>: the
// customer fills it in themselves, the lead is that person's ("From Nathan"), and the database
// decides whether it is Already ours (staff_lead_check: no link bonus, the KPIs still count).
//
//   clientForToken(admin, token)        -> the client row or null
//   rewardTerms(admin, client)          -> what the form shows beside each choice
//   submitReferral(admin, client, body) -> { kind: 'lead', id } or { kind: 'quote', id, ref }
//   referralRows(admin, clientIds)      -> the referrer's referrals for the portal's Quotes list
//   staffForToken(admin, token)         -> the active staff member's { id, full_name } or null
//   staffLinkInfo(admin, staff)         -> what their form shows: first name, the heard-of-us choices, the team
//                                          (publicInfo() drops the user ids before it leaves the server)
//   submitStaffLead(admin, staff, body) -> { kind: 'lead', id }
// Writes leads, lead-uploads storage, projects (through portal-requests.js for "Me"), activity_log,
// notifications.

const { addressColumns } = require('./address-parts');
const crypto = require('crypto');
const { fmtDay } = require('./schedule-emails');
const R = require('./portal-requests');

class Refused extends Error { constructor(msg) { super(msg); this.statusCode = 400; } }
const clean = (s, n) => String(s || '').trim().slice(0, n);
const TOKEN = /^[0-9a-f]{32}$/;
const TYPES = ['Solar', 'Battery', 'Switchboard upgrade', 'Fault find', 'Renovation', 'Service work', 'Other'];
const PER_HOUR = 10;
const OK_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
const MAX_FILES = 5; // the same as a portal request, which the "Me" path is
// The answers the form asks per job type, and only those. Ids that are the quote's own questions
// carry onto the quote (QUOTE_ANSWER_IDS in new-project.html); the others stay in the lead's notes.
// A select answer must be one of the quote question's options (or Not sure).
const { SOLAR_QUESTIONS, TEMPLATE_QUESTIONS } = require('../../../public/js/template-questions.js');
const optionsOf = (id) => ([...SOLAR_QUESTIONS, ...Object.values(TEMPLATE_QUESTIONS).flat()].find((q) => q && q.id === id) || {}).options;
const YES_NO = ['Yes', 'No', 'Not sure'];
const ANSWERS = {
  'Solar': { roof_type: optionsOf('roof_type'), phases: optionsOf('phases'), with_battery: YES_NO, existing_pv: null },
  'Battery': { backup_needs: null, existing_pv: null, phases: optionsOf('phases') },
  'Switchboard upgrade': { board_age: null, board_reason: null },
  'Fault find': { fault: null, urgency: optionsOf('urgency') },
  'Renovation': { reno_scope: null, reno_when: null },
  'Service work': { fault: null, urgency: optionsOf('urgency') },
  'Other': {},
};
function cleanAnswers(type, raw) {
  const allowed = ANSWERS[type] || {};
  const out = {};
  Object.entries(allowed).forEach(([id, options]) => {
    const v = clean((raw || {})[id], 300);
    if (!v) return;
    if (options && !options.concat('Not sure').includes(v)) return;
    out[id] = v;
  });
  return out;
}
const MAX_TOTAL = 4 * 1024 * 1024;
const money = (n) => `$${Number(n || 0).toLocaleString('en-AU', { maximumFractionDigits: 0 })}`;

async function clientForToken(admin, token) {
  if (!TOKEN.test(String(token || ''))) return null;
  const cols = 'id, name, email, phone, address, lead_reward_kind, portal_off_at';
  let { data } = await admin.from('clients').select(cols).eq('referral_token', token).maybeSingle();
  if (!data) {
    // a client merged into another (item 110): their old link sends work under the client they are now
    const { data: merged } = await admin.from('client_merges').select('from_client_id').eq('from_referral_token', token).maybeSingle();
    const { data: nowId } = merged ? await admin.rpc('client_now', { p_client_id: merged.from_client_id }) : { data: null };
    if (nowId) ({ data } = await admin.from('clients').select(cols).eq('id', nowId).maybeSingle());
  }
  return data && !data.portal_off_at ? data : null;
}

async function rewardTerms(admin, client) {
  if (!client || client.lead_reward_kind === 'off') return null;
  const { data: s } = await admin.from('company_settings').select('lead_reward_tiers, lead_reward_quick_amount, lead_reward_min_job').eq('id', 1).maybeSingle();
  const tiers = ((s && s.lead_reward_tiers) || []).slice().sort((a, b) => a.from - b.from);
  const how = 'a credit off your next invoice with us'; // credits only (owner, 20 Nov 2026)
  return {
    how,
    quick: `${money(s && s.lead_reward_quick_amount)} when we win the job (jobs over ${money(s && s.lead_reward_min_job)})`,
    full: tiers.map((t, i) => `${money(t.amount)} on a job ${tiers[i + 1] ? `${money(t.from)} to ${money(tiers[i + 1].from)}` : `over ${money(t.from)}`}`).join(', '),
  };
}

const digits = (s) => String(s || '').replace(/\D/g, '');
async function alreadyClient(admin, client, person) {
  const email = String(person.email || '').trim().toLowerCase();
  const phone = digits(person.phone);
  if ((email && String(client.email || '').toLowerCase() === email) || (phone && phone.length >= 8 && digits(client.phone).endsWith(phone.slice(-8)))) return true;
  const street = String(person.address || '').trim().toLowerCase().split(',')[0];
  if (street.length < 6) return false;
  const { data } = await admin.from('projects').select('id, client_address, pipeline_stage').ilike('client_address', `${street.replace(/[\\%_]/g, '\\$&')}%`).not('pipeline_stage', 'in', '(complete,archived)').limit(1);
  return !!(data && data.length);
}

// body: { who: 'me' | 'other', kind: 'quick' | 'full', type, need, answers, person: { name, phone,
//   email, address }, told, files, dueDate }
// A lead keeps its address in its own columns (line, suburb, state, postcode and the map point):
// filled from Google's lookup on the referral page's address box when it came (item 103).
function leadAddress(input, address) {
  const parts = addressColumns(input, address).address_parts;
  if (!parts) return {};
  return {
    address_line: [parts.unit ? `${parts.unit}/${parts.street_number}` : parts.street_number, parts.street_name, parts.street_type].filter(Boolean).join(' '),
    suburb: parts.suburb || null, state: parts.state || null, postcode: parts.postcode || null, lat: parts.lat, lng: parts.lng,
  };
}

// This use of a link is logged first and then counted with the hour's others, so many at the same
// moment cannot all slip under the limit.
async function countUse(admin, entityType, entityId, description) {
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  await admin.from('activity_log').insert({ entity_type: entityType, entity_id: entityId, action: 'referral_link_used', description });
  const { count } = await admin.from('activity_log').select('id', { count: 'exact', head: true }).eq('entity_type', entityType).eq('entity_id', entityId).eq('action', 'referral_link_used').gte('created_at', since);
  if ((count || 0) > PER_HOUR) throw new Refused('That is a lot in an hour. Please call us instead.');
}

// The photos sent with a form: checked (kind, count, size) before anything is written.
function checkFiles(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_FILES) throw new Refused(`Up to ${MAX_FILES} photos, please.`);
  let total = 0;
  return list.map((f) => {
    const mime = String(f.type || '').toLowerCase();
    if (!OK_MIME.test(mime)) throw new Refused('Photos (JPG, PNG, HEIC) and PDFs only, please.');
    const bytes = Buffer.from(String(f.data || ''), 'base64');
    total += bytes.length;
    if (!bytes.length || total > MAX_TOTAL) throw new Refused('The photos come to more than 4 MB. Send fewer, or smaller ones.');
    return { mime, bytes, name: clean(f.name, 100).replace(/[^a-zA-Z0-9._ -]/g, '_') || 'photo' };
  });
}
// ...then saved in the private lead-uploads bucket and listed on the lead's details.
async function saveFiles(admin, leadId, files, details) {
  const attachments = [];
  for (const f of files) {
    const path = `referrals/${leadId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${f.name.replace(/\s+/g, '_')}`;
    const { error: upErr } = await admin.storage.from('lead-uploads').upload(path, f.bytes, { contentType: f.mime, upsert: false });
    if (upErr) { console.error('referral photo not saved', upErr.message); continue; }
    attachments.push({ path, name: f.name, type: f.mime });
  }
  if (attachments.length) await admin.from('leads').update({ details: { ...details, attachments } }).eq('id', leadId);
}

async function submitReferral(admin, client, body) {
  await countUse(admin, 'client', client.id, `Referral link used (${body.who === 'me' ? 'their own job' : 'a referral'})`);

  const type = TYPES.includes(body.type) ? body.type : 'Other';
  const need = clean(body.need, 3000);
  if (need.length < 5) throw new Refused('A line about what is needed, please.');
  const answers = cleanAnswers(type, body.answers);

  // Their own job: the same as Request work in the portal (a draft quote with the date they need it by).
  if (body.who === 'me') {
    const scope = { email: 'their referral link', firstName: '', clients: [{ id: client.id, name: client.name, main: true }] };
    const extra = Object.entries(answers).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('\n');
    const made = await R.createRequest(admin, scope, { clientId: client.id, address: body.person && body.person.address, addressParts: body.person && body.person.addressParts, need: `${type}: ${need}${extra ? `\n${extra}` : ''}`, kind: 'quote', dueDate: body.dueDate, files: body.files });
    return { kind: 'quote', id: made.id, ref: made.ref };
  }

  const person = body.person || {};
  const name = clean(person.name, 120);
  const phone = clean(person.phone, 40);
  const email = clean(person.email, 160).toLowerCase();
  const address = clean(person.address, 300);
  if (name.length < 2) throw new Refused('Their name, please.');
  if (digits(phone).length < 8 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Refused('A phone number or an email for them, please.');
  if (!body.told) throw new Refused('Please tick that you have told them we will be in touch.');
  const kind = body.kind === 'full' ? 'full' : 'quick';

  const files = checkFiles(body.files); // before anything is written

  const already = await alreadyClient(admin, client, { email, phone, address });
  const { data: lead, error } = await admin.from('leads').insert({
    source: 'portal_referral', name, phone: phone || null, email: email || null, address_formatted: address || null, ...leadAddress(person.addressParts, address),
    details: { ...answers, job_type: type, what_they_need: need, referred_by: client.name },
    referrer_client_id: client.id, referral_kind: kind, already_client: already, status: 'new',
  }).select('id').single();
  if (error) throw error;

  await saveFiles(admin, lead.id, files, { ...answers, job_type: type, what_they_need: need, referred_by: client.name });

  await admin.from('activity_log').insert({ entity_type: 'client', entity_id: client.id, action: 'referral_sent', description: `${client.name} referred ${name} (${type}, ${kind})${already ? ', already a client' : ''}` });
  const office = await R.officeIds(admin);
  for (const uid of office) {
    await admin.rpc('create_notification', { p_user: uid, p_kind: 'lead', p_title: `Referral from ${client.name}: ${name}`, p_body: `${type}${address ? `, ${address.split(',').slice(-2).join(',').trim()}` : ''}. ${need.slice(0, 120)}`, p_link: '/leads.html', p_actor: null, p_dedupe: `referral:${lead.id}` });
  }
  return { kind: 'lead', id: lead.id };
}

// The referrer's referrals for their portal Quotes list: the person's name, the type and the suburb,
// a status word, never the price or the street.
async function referralRows(admin, clientIds) {
  if (!clientIds.length) return [];
  const { data: leads } = await admin.from('leads').select('id, name, details, status, created_at, already_client, address_formatted').in('referrer_client_id', clientIds).order('created_at', { ascending: false }).limit(50);
  const ids = (leads || []).map((l) => l.id);
  const { data: quotes } = ids.length ? await admin.from('projects').select('id, lead_id, quote_number, status, sent_at, approved_at, declined_at, expired').in('lead_id', ids) : { data: [] };
  return (leads || []).map((l) => {
    const q = (quotes || []).find((x) => x.lead_id === l.id);
    const suburb = String(l.address_formatted || '').split(',').slice(-2, -1).join('').trim();
    let status = 'Sent to us';
    // already_client stays with staff: telling the referrer would say whether someone has a job there
    if (q && (q.approved_at || q.status === 'approved')) status = 'Won';
    else if (q && (q.declined_at || q.expired || q.status === 'declined')) status = 'Not won';
    else if (q && q.sent_at) status = 'Quoted';
    else if (q) status = 'Being quoted';
    else if (l.already_client) status = 'Sent to us';
    else if (l.status === 'dead' || l.status === 'lost') status = 'Not won';
    const who = String(l.name || '').trim().split(/\s+/);
    const short = who.length > 1 ? `${who[0][0]}. ${who.slice(1).join(' ')}` : who[0] || 'Someone';
    return { id: l.id, ref: q && q.quote_number ? `Q${q.quote_number}` : '', name: `Referred: ${short}, ${String((l.details && l.details.job_type) || 'job').toLowerCase()}${suburb ? `, ${suburb}` : ''}`, status, when: fmtDay(String(l.created_at).slice(0, 10)), open: !['Won', 'Not won'].includes(status) };
  });
}

// ---- A staff member's personal link (item 74b 7a) ----

async function staffForToken(admin, token) {
  if (!TOKEN.test(String(token || ''))) return null;
  const { data: link } = await admin.from('staff_referral_links').select('profile_id').eq('token', token).maybeSingle();
  if (!link) return null;
  const { data: who } = await admin.from('profiles').select('id, full_name, active').eq('id', link.profile_id).maybeSingle();
  return who && who.active ? who : null; // the link stops the day they are made inactive
}

const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || 'Our team';
// "Nathan S" for the list of other staff: enough to pick the right person, no full surnames on a public page
const shortName = (full) => { const w = String(full || '').trim().split(/\s+/); return w.length > 1 ? `${w[0]} ${w[w.length - 1][0]}` : w[0] || ''; };

async function staffLinkInfo(admin, staff) {
  const [{ data: s }, { data: team }] = await Promise.all([
    admin.from('company_settings').select('heard_from_options').eq('id', 1).maybeSingle(),
    admin.from('profiles').select('id, full_name').eq('active', true).neq('id', staff.id).order('full_name'),
  ]);
  return {
    staff: firstName(staff.full_name),
    heard: ((s && s.heard_from_options) || []).map((o) => clean(o, 80)).filter(Boolean),
    // each person goes out under a code made for this link, never their user id; profileId stays on the server
    team: (team || []).filter((p) => p.full_name).map((p) => ({ id: crypto.createHash('sha256').update(`${staff.id}:${p.id}`).digest('hex').slice(0, 16), name: shortName(p.full_name), profileId: p.id })),
  };
}
const publicInfo = (info) => ({ ...info, team: info.team.map(({ id, name }) => ({ id, name })) });

// body: { type, need, answers, person: { name, phone, email, address, addressParts }, files,
//   heard: 'owner' | 'staff' | one of the Settings choices, heardStaffId }
async function submitStaffLead(admin, staff, body) {
  await countUse(admin, 'profile', staff.id, 'Staff link used');
  const type = TYPES.includes(body.type) ? body.type : 'Other';
  const need = clean(body.need, 3000);
  if (need.length < 5) throw new Refused('A line about what you need, please.');
  const answers = cleanAnswers(type, body.answers);
  const person = body.person || {};
  const name = clean(person.name, 120);
  const phone = clean(person.phone, 40);
  const email = clean(person.email, 160).toLowerCase();
  const address = clean(person.address, 300);
  if (name.length < 2) throw new Refused('Your name, please.');
  if (digits(phone).length < 8 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Refused('A phone number or an email, please.');

  // how they heard of us: the link's owner, someone else here, or one of the choices from Settings
  const info = await staffLinkInfo(admin, staff);
  let heardFrom = null;
  let heardProfile = null;
  if (body.heard === 'owner') { heardFrom = 'Thomson Energy staff'; heardProfile = staff.id; }
  else if (body.heard === 'staff') {
    const picked = info.team.find((p) => p.id === body.heardStaffId);
    if (!picked) throw new Refused('Pick who told you about us, please.');
    heardFrom = 'Thomson Energy staff'; heardProfile = picked.profileId;
  } else if (info.heard.includes(body.heard)) heardFrom = body.heard;
  else throw new Refused('Tell us how you first heard about Thomson Energy, please.');

  const files = checkFiles(body.files);
  const details = { ...answers, job_type: type, what_they_need: need, referred_by: staff.full_name };
  const { data: lead, error } = await admin.from('leads').insert({
    source: 'staff_link', name, phone: phone || null, email: email || null, address_formatted: address || null, ...leadAddress(person.addressParts, address),
    details, referrer_profile_id: staff.id, heard_from: heardFrom, heard_from_profile_id: heardProfile, status: 'new',
    // no bonus until the check below has run: if it fails, an admin clears the lead by hand
    already_client: true, already_reason: 'not checked yet',
  }).select('id').single();
  if (error) throw error;

  // new, or someone we already had (no link bonus; the KPIs still count); before the photos, which take time
  const { data: checked, error: checkErr } = await admin.rpc('staff_lead_check', { p_lead: lead.id });
  if (checkErr) console.error('staff_lead_check failed', checkErr.message);
  const reason = checkErr ? 'not checked yet' : checked;
  await saveFiles(admin, lead.id, files, details);
  const office = await R.officeIds(admin);
  for (const uid of office) {
    await admin.rpc('create_notification', { p_user: uid, p_kind: 'lead', p_title: `Lead from ${firstName(staff.full_name)}'s link: ${name}`, p_body: `${type}${address ? `, ${address.split(',').slice(-2).join(',').trim()}` : ''}. ${need.slice(0, 120)}${reason ? ' (Already ours: no bonus)' : ''}`, p_link: '/leads.html', p_actor: null, p_dedupe: `staff-lead:${lead.id}` });
  }
  return { kind: 'lead', id: lead.id };
}

module.exports = { clientForToken, rewardTerms, submitReferral, referralRows, staffForToken, staffLinkInfo, publicInfo, submitStaffLead, TYPES };
