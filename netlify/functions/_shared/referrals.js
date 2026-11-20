// The referral link (backlog item 74b, step 3a: no money). A client's private link
// refer.html?r=<clients.referral_token> sends us work with no login: the link only ever sends a lead
// in that client's name and reads nothing back but the client's name and the reward amounts.
// Called by refer.js (public, the token is the check), portal-read.js (the referrer's rows) and
// client-referral.js (staff: the link, Regenerate, Send link).
//
//   clientForToken(admin, token)        -> the client row or null
//   rewardTerms(admin, client)          -> what the form shows beside each choice
//   submitReferral(admin, client, body) -> { kind: 'lead', id } or { kind: 'quote', id, ref }
//   referralRows(admin, clientIds)      -> the referrer's referrals for the portal's Quotes list
// Writes leads, lead-uploads storage, projects (through portal-requests.js for "Me"), activity_log,
// notifications.

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
  const { data } = await admin.from('clients').select('id, name, email, phone, address, lead_reward_kind, portal_off_at').eq('referral_token', token).maybeSingle();
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
async function submitReferral(admin, client, body) {
  // this use is logged first and then counted with the hour's others, so many at the same moment
  // cannot all slip under the limit
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  await admin.from('activity_log').insert({ entity_type: 'client', entity_id: client.id, action: 'referral_link_used', description: `Referral link used (${body.who === 'me' ? 'their own job' : 'a referral'})` });
  const { count } = await admin.from('activity_log').select('id', { count: 'exact', head: true }).eq('entity_type', 'client').eq('entity_id', client.id).eq('action', 'referral_link_used').gte('created_at', since);
  if ((count || 0) > PER_HOUR) throw new Refused('That is a lot in an hour. Please call us instead.');

  const type = TYPES.includes(body.type) ? body.type : 'Other';
  const need = clean(body.need, 3000);
  if (need.length < 5) throw new Refused('A line about what is needed, please.');
  const answers = cleanAnswers(type, body.answers);

  // Their own job: the same as Request work in the portal (a draft quote with the date they need it by).
  if (body.who === 'me') {
    const scope = { email: 'their referral link', firstName: '', clients: [{ id: client.id, name: client.name, main: true }] };
    const extra = Object.entries(answers).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('\n');
    const made = await R.createRequest(admin, scope, { clientId: client.id, address: body.person && body.person.address, need: `${type}: ${need}${extra ? `\n${extra}` : ''}`, kind: 'quote', dueDate: body.dueDate, files: body.files });
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

  // files are checked before anything is written
  const list = Array.isArray(body.files) ? body.files : [];
  if (list.length > MAX_FILES) throw new Refused(`Up to ${MAX_FILES} photos, please.`);
  let total = 0;
  const files = list.map((f) => {
    const mime = String(f.type || '').toLowerCase();
    if (!OK_MIME.test(mime)) throw new Refused('Photos (JPG, PNG, HEIC) and PDFs only, please.');
    const bytes = Buffer.from(String(f.data || ''), 'base64');
    total += bytes.length;
    if (!bytes.length || total > MAX_TOTAL) throw new Refused('The photos come to more than 4 MB. Send fewer, or smaller ones.');
    return { mime, bytes, name: clean(f.name, 100).replace(/[^a-zA-Z0-9._ -]/g, '_') || 'photo' };
  });

  const already = await alreadyClient(admin, client, { email, phone, address });
  const { data: lead, error } = await admin.from('leads').insert({
    source: 'portal_referral', name, phone: phone || null, email: email || null, address_formatted: address || null,
    details: { ...answers, job_type: type, what_they_need: need, referred_by: client.name },
    referrer_client_id: client.id, referral_kind: kind, already_client: already, status: 'new',
  }).select('id').single();
  if (error) throw error;

  const attachments = [];
  for (const f of files) {
    const path = `referrals/${lead.id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${f.name.replace(/\s+/g, '_')}`;
    const { error: upErr } = await admin.storage.from('lead-uploads').upload(path, f.bytes, { contentType: f.mime, upsert: false });
    if (upErr) { console.error('referral photo not saved', upErr.message); continue; }
    attachments.push({ path, name: f.name, type: f.mime });
  }
  if (attachments.length) await admin.from('leads').update({ details: { ...answers, job_type: type, what_they_need: need, referred_by: client.name, attachments } }).eq('id', lead.id);

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

module.exports = { clientForToken, rewardTerms, submitReferral, referralRows, TYPES };
