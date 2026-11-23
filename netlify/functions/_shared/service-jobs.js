// Price list jobs: disconnect and reconnect at fixed prices (backlog item 109). The one copy of how:
// setting a job up, the crew's sheet, what the job is charged, the roofer's booking questions, the
// price email and the upgrade quote. Called by service-job.js (staff), service-booking.js (the
// roofer's link, no login), portal-requests.js (a request from the portal), job-actuals.js and
// create-invoice.js / update-invoice-lines.js (the invoice). Plain inputs, plain results; throws
// Refused (statusCode 400) with a message a person can read.
//
//   setupServiceJob(admin, projectId, actorId, { emailQuestions })  make a job a price list job
//   sheetData(admin, projectId, { withPrices })                     the sheet: items, quantities, photos
//   saveSheet(admin, projectId, user, input)                        quantities, and finishing a sheet
//   saveAnswer(admin, projectId, user, input)                       one photo or yes / no on the sheet
//   pricedLines(lines)                                              each line at the price list price
//   serviceActuals(admin, projectId, centres, invItems)             per cost centre, for the invoice panel
//   forceServicePrices(admin, projectId, claims)                    an invoice never carries another price
//   bookingByToken / saveBooking                                    the roofer's answers
//   priceEmailDraft / sendPriceEmail / sendQuestionsEmail
// Writes projects (service_* columns), cost_centres, job_service_lines, job_sheet_answers, job_tasks,
// job_contacts, project_photos, clients, activity_log, notifications.

const crypto = require('crypto');
const { publicBaseUrl } = require('./site-url');

const GROUP = 'Disconnect and reconnect';
const DISCONNECT = 'Disconnection';
const RECONNECT = 'Reconnection';
const UPGRADE_NOTE = 'Refitting your panels is already covered in your roofing quote, so it is allowed for in this price.';

class Refused extends Error { constructor(msg) { super(msg); this.statusCode = 400; } }
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${r2(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const jobRef = (p) => (p.job_number ? `J${p.job_number}` : p.quote_number ? `Q${p.quote_number}` : 'Job');
const must = ({ data, error }) => { if (error) throw error; return data; };

// ---------------------------------------------------------------- prices

// A line at the price list price. The quantity charged is never under the item's minimum; the price
// each is split between the two visits by the item's disconnect share, to the cent, so the two
// halves always add back to the price.
function pricedLine(l) {
  const counted = Number(l.quantity) || 0;
  const min = Number(l.min_quantity) || 0;
  const quantity = counted > 0 ? Math.max(counted, min) : 0;
  const unitPrice = r2(l.unit_price);
  const disconnectUnit = r2(unitPrice * (Number(l.disconnect_share) || 0) / 100);
  const underMin = counted > 0 && counted < min;
  return {
    id: l.id, prebuildId: l.prebuild_id, counted, quantity, unitPrice, unitLabel: l.unit_label || 'each',
    description: underMin ? `${l.description} (${counted} on site, minimum ${min})` : l.description,
    amount: r2(quantity * unitPrice),
    disconnectUnit, reconnectUnit: r2(unitPrice - disconnectUnit),
  };
}
const pricedLines = (lines) => (lines || []).map(pricedLine).filter((l) => l.quantity > 0);

async function jobLines(admin, projectId) {
  return must(await admin.from('job_service_lines').select('*').eq('project_id', projectId).order('sort_order')) || [];
}

// The two cost centres a price list job is costed to.
function serviceCentres(centres) {
  const group = (centres || []).filter((c) => c.bill_group === GROUP);
  const disconnect = group.find((c) => c.name === DISCONNECT) || group[0] || null;
  const reconnect = group.find((c) => c.name === RECONNECT) || group.find((c) => c !== disconnect) || disconnect;
  return { disconnect, reconnect, ids: new Set(group.map((c) => c.id)) };
}

// For the invoice panel and Left to invoice: what each of the two cost centres still has to bill.
// A line is billed for a cost centre once an invoice line on that cost centre carries its prebuild;
// what is left is the quantity charged less the quantity already on invoices.
// invItems: the job's invoice_line_items ({ cost_centre_id, prebuild_id, kind, quantity, invoices }). Every
// invoice counts, the one being edited too: its own lines are already in the panel.
async function serviceActuals(admin, projectId, centres, invItems) {
  const { disconnect, reconnect, ids } = serviceCentres(centres);
  if (!disconnect) return { ids, byCentre: {}, lines: [] };
  const lines = pricedLines(await jobLines(admin, projectId));
  const billedQty = (centreId, prebuildId) => (invItems || [])
    .filter((i) => i.kind === 'prebuild' && i.cost_centre_id === centreId && i.prebuild_id === prebuildId)
    .reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const invoiceNumber = (centreId, prebuildId) => ((invItems || []).find((i) => i.kind === 'prebuild' && i.cost_centre_id === centreId && i.prebuild_id === prebuildId) || {}).invoices?.invoice_number || null;
  const byCentre = {};
  const add = (centre, l, unit) => {
    if (!(unit > 0)) return;
    const left = r2(l.quantity - billedQty(centre.id, l.prebuildId));
    (byCentre[centre.id] = byCentre[centre.id] || []).push({
      prebuildId: l.prebuildId, name: l.description, quantity: Math.max(0, left), fullQuantity: l.quantity, unitPrice: unit,
      invoiced: left <= 0.004, invoiceNumber: invoiceNumber(centre.id, l.prebuildId),
    });
  };
  lines.forEach((l) => {
    if (disconnect.id === reconnect.id) { add(disconnect, l, l.unitPrice); return; }
    add(disconnect, l, l.disconnectUnit);
    add(reconnect, l, l.reconnectUnit);
  });
  return { ids, byCentre, lines };
}

// An invoice on a price list job never carries another price for a price list line: whatever the
// panel sent, a prebuild on one of the two cost centres that is on the job's sheet is priced here.
// Changes the claims in place. Does nothing on any other job.
async function forceServicePrices(admin, projectId, claims) {
  const project = must(await admin.from('projects').select('service_price_job').eq('id', projectId).maybeSingle());
  if (!project || !project.service_price_job) return;
  const centres = must(await admin.from('cost_centres').select('id, name, bill_group, sort_order').eq('project_id', projectId).order('sort_order'));
  const { disconnect, reconnect, ids } = serviceCentres(centres);
  if (!disconnect) return;
  const byPrebuild = new Map(pricedLines(await jobLines(admin, projectId)).map((l) => [l.prebuildId, l]));
  (claims || []).forEach((c) => {
    if (!ids.has(c.costCentreId)) return;
    (c.items || []).forEach((it) => {
      const l = it && it.kind === 'prebuild' ? byPrebuild.get(it.prebuildId) : null;
      if (!l) return;
      it.unitPrice = disconnect.id === reconnect.id ? l.unitPrice : (c.costCentreId === disconnect.id ? l.disconnectUnit : l.reconnectUnit);
      it.description = l.description;
    });
  });
}

// ---------------------------------------------------------------- setting a job up

async function officeIds(admin) {
  return require('./portal-requests').officeIds(admin);
}
async function tell(admin, ids, { title, body, link, dedupe }) {
  for (const uid of ids) await admin.rpc('create_notification', { p_user: uid, p_kind: 'booking_reminder', p_title: title, p_body: body, p_link: link, p_actor: null, p_dedupe: dedupe });
}
const log = (admin, projectId, action, description) => admin.from('activity_log').insert({ entity_type: 'project', entity_id: projectId, action, description });

async function readProject(admin, projectId) {
  const p = must(await admin.from('projects').select('id, name, job_number, quote_number, proposal_template, source_quote_id, client_id, client_name, client_email, client_phone, client_address, client_site_id, address_parts, lat, lng, service_price_job, service_booking, service_booking_token, service_state').eq('id', projectId).maybeSingle());
  if (!p) throw new Refused('That job was not found.');
  return p;
}

// Makes a job a price list job: marked, two cost centres that bill as one, the two sheets as tasks,
// and the roofer's link to the booking questions. A job with one cost centre keeps it as
// Disconnection, so hours and materials already on it stay where they are. Safe to call twice.
async function setupServiceJob(admin, projectId, actorId, { emailQuestions = false } = {}) {
  const p = await readProject(admin, projectId);
  if (!p.job_number) throw new Refused('Only a job can be a disconnect and reconnect job.');
  if (p.source_quote_id) throw new Refused('This job came from a quote, so it is invoiced against the quote.');
  if (!p.service_price_job) {
    const { count, error } = await admin.from('invoices').select('id', { count: 'exact', head: true }).eq('project_id', projectId);
    if (error) throw error;
    if (count) throw new Refused('This job already has an invoice, so its type stays as it is. Add the price list prebuilds to its next invoice instead.');
  }
  const centres = must(await admin.from('cost_centres').select('id, name, sort_order, bill_group, variation_entry_id').eq('project_id', projectId).order('sort_order')) || [];
  const own = centres.filter((c) => !c.variation_entry_id);
  const has = (name) => centres.find((c) => c.bill_group === GROUP && c.name === name);
  const settings = must(await admin.from('company_settings').select('default_markup_percent').eq('id', 1).maybeSingle());
  const markup = Number(settings && settings.default_markup_percent) || 45;
  const lastSort = centres.reduce((m, c) => Math.max(m, Number(c.sort_order) || 0), 0);
  if (!has(DISCONNECT)) {
    if (own.length === 1 && !own[0].bill_group) {
      must(await admin.from('cost_centres').update({ name: DISCONNECT, bill_group: GROUP }).eq('id', own[0].id).select('id'));
    } else {
      must(await admin.from('cost_centres').insert({ project_id: projectId, name: DISCONNECT, bill_group: GROUP, sort_order: lastSort + 1, markup_percent: markup }).select('id'));
    }
  }
  if (!has(RECONNECT)) {
    must(await admin.from('cost_centres').insert({ project_id: projectId, name: RECONNECT, bill_group: GROUP, sort_order: lastSort + 2, markup_percent: markup }).select('id'));
  }
  const state = { ...(p.service_state || {}) };
  if (!state.tasks) {
    const rows = must(await admin.from('job_tasks').insert([
      { project_id: projectId, description: 'Disconnect sheet: count what came off and take the photos', task_type: 'onsite', required_before_scheduling: false, created_by: actorId || null },
      { project_id: projectId, description: 'Reconnect sheet: confirm what went back on', task_type: 'onsite', required_before_scheduling: false, created_by: actorId || null },
    ]).select('id'));
    state.tasks = { disconnect: rows[0].id, reconnect: rows[1].id };
  }
  const token = p.service_booking_token || crypto.randomUUID();
  must(await admin.from('projects').update({ service_price_job: true, proposal_template: 'direct_job', service_booking_token: token, service_state: state }).eq('id', projectId).select('id'));
  if (!p.service_price_job) await log(admin, projectId, 'job_type', 'Job type set to Disconnect and reconnect (billed from the price list)');

  let questions = null;
  if (emailQuestions && !p.service_booking) {
    try { await sendQuestionsEmail(admin, projectId, actorId); questions = 'sent'; } catch (err) { questions = err.message; }
  }
  return { ok: true, bookingUrl: bookingUrl(token), questions };
}

const bookingUrl = (token) => `${publicBaseUrl()}/booking-questions.html?token=${token}`;

// ---------------------------------------------------------------- the sheet

async function sheetTemplate(admin) {
  const templates = must(await admin.from('inspection_checklist_templates').select('id, name').eq('checklist_type', 'job_sheet').eq('active', true).order('sort_order').limit(1));
  if (!templates || !templates.length) return { items: [] };
  const items = must(await admin.from('inspection_checklist_items').select('id, item_type, label, description, required, sort_order').eq('template_id', templates[0].id).order('sort_order'));
  return { name: templates[0].name, items: items || [] };
}

// What the roofer told us, as starting quantities.
function prefill(fillsFrom, booking) {
  const b = booking || {};
  const panels = Math.max(0, Math.round(Number(b.panel_count) || 0));
  if (fillsFrom === 'panel_count') return panels;
  if (fillsFrom === 'roof_change') return b.old_roof && b.new_roof && b.old_roof !== b.new_roof ? panels : 0;
  return null;
}

async function sheetData(admin, projectId, { withPrices = false } = {}) {
  const p = await readProject(admin, projectId);
  if (!p.service_price_job) throw new Refused('This is not a disconnect and reconnect job.');
  const [prices, lines, template, answers, settings] = await Promise.all([
    admin.from('service_price_items').select('prebuild_id, shown, unit_price, unit_label, min_quantity, disconnect_share, fills_from, sort_order, prebuilds(name, subcategory)').order('sort_order').then(must),
    jobLines(admin, projectId),
    sheetTemplate(admin),
    admin.from('job_sheet_answers').select('item_id, answer_yes_no, photo_path').eq('project_id', projectId).then(must),
    admin.from('company_settings').select('service_booking_questions, service_price_email_auto').eq('id', 1).maybeSingle().then(must),
  ]);
  const lineBy = new Map(lines.map((l) => [l.prebuild_id, l]));
  // every shown item, plus anything already counted on this job even if it has since been hidden
  const items = (prices || []).filter((s) => s.shown || lineBy.has(s.prebuild_id)).map((s) => {
    const line = lineBy.get(s.prebuild_id);
    const start = prefill(s.fills_from, p.service_booking);
    return {
      prebuildId: s.prebuild_id, name: line ? line.description : (s.prebuilds && s.prebuilds.name) || 'Item', group: (s.prebuilds && s.prebuilds.subcategory) || '',
      unitLabel: s.unit_label, quantity: line ? Number(line.quantity) || 0 : (start || 0), fromBooking: !line && start != null,
      ...(withPrices ? { unitPrice: Number(line ? line.unit_price : s.unit_price) || 0, minQuantity: Number(line ? line.min_quantity : s.min_quantity) || null } : {}),
    };
  });
  const answerBy = new Map((answers || []).map((a) => [a.item_id, a]));
  const checklist = template.items.map((it) => {
    const a = answerBy.get(it.id);
    return { id: it.id, type: it.item_type, label: it.label, description: it.description || '', needed: !!it.required, photo: (a && a.photo_path) || null, answer: a ? a.answer_yes_no : null };
  });
  const isDone = (c) => (c.type === 'photo' ? !!c.photo : c.answer !== null && c.answer !== undefined);
  const questions = (settings && settings.service_booking_questions) || [];
  const out = {
    project: { id: p.id, ref: jobRef(p), name: p.name, clientName: p.client_name, address: p.client_address },
    items, checklist, missing: checklist.filter((c) => c.needed && !isDone(c)).map((c) => c.label),
    state: p.service_state || {},
    booking: questions.map((q) => ({ label: q.label, value: (p.service_booking || {})[q.key] })).filter((b) => b.value !== undefined && b.value !== null && b.value !== ''),
    booked: !!p.service_booking,
  };
  if (withPrices) {
    const priced = pricedLines(lines);
    out.lines = priced;
    out.total = r2(priced.reduce((s, l) => s + l.amount, 0));
    out.bookingUrl = p.service_booking_token ? bookingUrl(p.service_booking_token) : null;
    out.clientEmail = p.client_email || '';
    out.autoEmail = !!(settings && settings.service_price_email_auto);
  }
  return out;
}

// input: { kind: 'disconnect' | 'reconnect', quantities: { prebuildId: number }, worthReplacing, finish }
// Quantities only: the price is copied from the price list the first time an item is counted on a
// job and never taken from the caller.
async function saveSheet(admin, projectId, user, input) {
  const p = await readProject(admin, projectId);
  if (!p.service_price_job) throw new Refused('This is not a disconnect and reconnect job.');
  const kind = input.kind === 'reconnect' ? 'reconnect' : 'disconnect';
  const quantities = input.quantities && typeof input.quantities === 'object' ? input.quantities : {};
  const [prices, lines] = await Promise.all([
    admin.from('service_price_items').select('prebuild_id, shown, unit_price, unit_label, min_quantity, disconnect_share, sort_order, prebuilds(name)').then(must),
    jobLines(admin, projectId),
  ]);
  const lineBy = new Map(lines.map((l) => [l.prebuild_id, l]));
  const now = new Date().toISOString();
  for (const s of prices || []) {
    if (!(s.prebuild_id in quantities)) continue;
    const qty = Number(quantities[s.prebuild_id]);
    if (!Number.isFinite(qty) || qty < 0 || qty > 100000) throw new Refused('A quantity is not a number.');
    const line = lineBy.get(s.prebuild_id);
    if (line) {
      if (Number(line.quantity) !== qty) must(await admin.from('job_service_lines').update({ quantity: qty, updated_at: now }).eq('id', line.id).select('id'));
    } else if (qty > 0) {
      if (!s.shown) throw new Refused('That item is no longer on the price list.');
      must(await admin.from('job_service_lines').insert({
        project_id: projectId, prebuild_id: s.prebuild_id, description: (s.prebuilds && s.prebuilds.name) || 'Item', unit_label: s.unit_label,
        quantity: qty, unit_price: s.unit_price, min_quantity: s.min_quantity, disconnect_share: s.disconnect_share, sort_order: s.sort_order, created_by: user.id,
      }).select('id'));
    }
  }
  if (!input.finish) return { ok: true, finished: false };

  const state = { ...(p.service_state || {}) };
  const first = !(state[kind] && state[kind].finished_at);
  state[kind] = { finished_at: now, finished_by: user.id, ...(kind === 'disconnect' ? { worth_replacing: !!input.worthReplacing } : {}) };
  must(await admin.from('projects').update({ service_state: state }).eq('id', projectId).select('id'));
  const taskId = state.tasks && state.tasks[kind];
  if (taskId) await admin.from('job_tasks').update({ completed: true, completed_by: user.id, completed_at: now }).eq('id', taskId).eq('completed', false);

  const data = await sheetData(admin, projectId, { withPrices: true });
  const ref = jobRef(p);
  const sheetName = kind === 'disconnect' ? 'Disconnect' : 'Reconnect';
  await log(admin, projectId, 'job_sheet', `${sheetName} sheet finished: ${data.lines.map((l) => `${l.counted} x ${l.description}`).join(', ') || 'nothing counted'}${data.missing.length ? `. Photos not taken: ${data.missing.join(', ')}` : ''}`);
  let upgrade = null;
  if (first) {
    let emailed = false;
    if (kind === 'disconnect' && data.autoEmail && p.client_email) {
      try { await sendPriceEmail(admin, projectId, user.id, await priceEmailDraft(admin, projectId)); emailed = true; } catch (err) { console.error('service price email not sent', ref, err.message); }
    }
    await tell(admin, await officeIds(admin), {
      title: kind === 'disconnect' ? `${ref}: disconnect done, ${emailed ? 'price sent' : 'check and send the price'}` : `${ref}: reconnect done, ready to invoice`,
      body: `${p.name || ''}: ${money(data.total)} ex GST from the price list.${data.missing.length ? ` Photos not taken: ${data.missing.join(', ')}.` : ''}`.trim(),
      link: `/project.html?id=${projectId}`, dedupe: `service-sheet:${projectId}:${kind}`,
    });
    if (kind === 'disconnect' && input.worthReplacing) upgrade = await createUpgradeQuote(admin, p, user.id, data);
  }
  return { ok: true, finished: true, missing: data.missing, upgrade };
}

// input: { itemId, photoPath?, answerYesNo? }. A photo also lands in the job's Photos, named by the item.
async function saveAnswer(admin, projectId, user, input) {
  const p = await readProject(admin, projectId);
  if (!p.service_price_job) throw new Refused('This is not a disconnect and reconnect job.');
  const item = must(await admin.from('inspection_checklist_items').select('id, label, item_type, inspection_checklist_templates!inner(checklist_type)').eq('id', input.itemId || '').eq('inspection_checklist_templates.checklist_type', 'job_sheet').maybeSingle());
  if (!item) throw new Refused('That is not an item on the sheet.');
  const row = { project_id: projectId, item_id: item.id, answered_by: user.id, answered_at: new Date().toISOString() };
  if (item.item_type === 'photo') {
    const path = clean(input.photoPath, 1000);
    // only a file in our own photo storage, never an address typed in from outside
    if (!path.startsWith(`${String(process.env.SUPABASE_URL || '').replace(/\/+$/, '')}/storage/v1/object/public/site-photos/`)) throw new Refused('The photo did not upload. Try again.');
    row.photo_path = path;
    must(await admin.from('project_photos').insert({ project_id: projectId, staff_id: user.id, url: path, caption: item.label }).select('id'));
  } else {
    row.answer_yes_no = !!input.answerYesNo;
  }
  must(await admin.from('job_sheet_answers').upsert(row, { onConflict: 'project_id,item_id' }).select('id'));
  return { ok: true };
}

// ---------------------------------------------------------------- the roofer's booking questions

async function questionSet(admin) {
  const s = must(await admin.from('company_settings').select('service_booking_questions, company_name, phone, logo_url').eq('id', 1).maybeSingle());
  return { questions: (s && s.service_booking_questions) || [], company: { name: (s && s.company_name) || 'Thomson Energy', phone: (s && s.phone) || '', logo: (s && s.logo_url) || '' } };
}

async function bookingByToken(admin, token) {
  if (!/^[0-9a-f-]{36}$/i.test(String(token || ''))) return null;
  const p = must(await admin.from('projects').select('id, name, job_number, quote_number, client_name, client_address, service_booking, service_state, service_price_job').eq('service_booking_token', token).maybeSingle());
  if (!p || !p.service_price_job) return null;
  const { questions, company } = await questionSet(admin);
  const closed = !!(p.service_state && p.service_state.disconnect && p.service_state.disconnect.finished_at);
  return { id: p.id, ref: jobRef(p), name: p.name, clientName: p.client_name, address: p.client_address, questions, answers: p.service_booking || {}, closed, company };
}

// Keeps only answers to the questions we ask, each as its own type.
function checkAnswers(questions, input) {
  const out = {};
  (questions || []).forEach((q) => {
    const v = input ? input[q.key] : undefined;
    if (v === undefined || v === null || v === '') return;
    if (q.type === 'number') {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 0 || n > 5000) throw new Refused(`"${q.label}" needs a number.`);
      out[q.key] = n;
    } else if (q.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Refused(`"${q.label}" needs a date.`);
      out[q.key] = String(v);
    } else if (q.type === 'choice') {
      if (!(q.options || []).includes(v)) throw new Refused(`Pick one of the choices for "${q.label}".`);
      out[q.key] = v;
    } else {
      out[q.key] = clean(v, q.type === 'longtext' ? 2000 : 200);
    }
  });
  return out;
}

// who: the words for the activity line ("the roofer, from the emailed link" or a portal email).
async function saveBooking(admin, projectId, input, who) {
  const p = await readProject(admin, projectId);
  if (!p.service_price_job) throw new Refused('This is not a disconnect and reconnect job.');
  if (p.service_state && p.service_state.disconnect && p.service_state.disconnect.finished_at) throw new Refused('The panels are already off, so these answers can no longer change. Please call us.');
  const { questions } = await questionSet(admin);
  const answers = checkAnswers(questions, input);
  if (!Object.keys(answers).length) throw new Refused('Answer at least one question.');
  const firstTime = !p.service_booking;
  must(await admin.from('projects').update({ service_booking: answers }).eq('id', projectId).select('id'));
  // the homeowner goes on the job as the site contact, once
  if (answers.homeowner_name) {
    const existing = must(await admin.from('job_contacts').select('id').eq('project_id', projectId).eq('side', 'site').eq('role', 'owner').limit(1));
    if (existing && existing.length) await admin.from('job_contacts').update({ name: answers.homeowner_name, phone: answers.homeowner_phone || null }).eq('id', existing[0].id);
    else await admin.from('job_contacts').insert({ project_id: projectId, side: 'site', role: 'owner', name: answers.homeowner_name, phone: answers.homeowner_phone || null, created_by: null });
  }
  const summary = questions.filter((q) => answers[q.key] !== undefined).map((q) => `${q.label} ${answers[q.key]}`).join('; ').slice(0, 900);
  await log(admin, projectId, 'service_booking', `Booking questions answered by ${who}: ${summary}`);
  await tell(admin, await officeIds(admin), {
    title: `${jobRef(p)}: booking questions answered`, body: `${p.name || ''}: ${summary}`.slice(0, 280),
    link: `/project.html?id=${projectId}`, dedupe: `service-booking:${projectId}:${firstTime ? 'first' : Date.now()}`,
  });
  return { ok: true };
}

// ---------------------------------------------------------------- emails

async function sendQuestionsEmail(admin, projectId, userId) {
  const p = await readProject(admin, projectId);
  if (!p.client_email) throw new Refused('The client has no email on the job, so the booking questions were not sent. Copy the link from the job instead.');
  if (!p.service_booking_token) throw new Refused('Set the job up first.');
  const { sendAsUser } = require('./send-recorded-email');
  const { questions } = await questionSet(admin);
  const bodyText = [
    `Hi ${String(p.client_name || '').split(' ')[0] || 'there'},`,
    '',
    `Thanks for the job at ${p.client_address || 'your site'} (${jobRef(p)}). So we turn up with the right gear, could you answer ${questions.length} quick questions:`,
    '',
    `[[button: Answer the booking questions | ${bookingUrl(p.service_booking_token)}]]`,
    '',
    'It takes about a minute, and you can change your answers until the day the panels come off.',
  ].join('\n');
  await sendAsUser(admin, { userId, to: p.client_email, subject: `${jobRef(p)}: a few questions before we book ${p.client_address || 'your job'}`, bodyText, tagProjectId: projectId, tagKind: 'client' });
  await log(admin, projectId, 'service_booking', `Booking questions emailed to ${p.client_email}`);
  return { ok: true };
}

async function priceEmailDraft(admin, projectId) {
  const data = await sheetData(admin, projectId, { withPrices: true });
  const p = data.project;
  const rows = data.lines.map((l) => `${l.description}: ${l.quantity} x ${money(l.unitPrice)} = ${money(l.amount)}`);
  const bodyText = [
    `Hi ${String(p.clientName || '').split(' ')[0] || 'there'},`,
    '',
    `The panels are off at ${p.address || 'the site'} (${p.ref}). This is what the job comes to from the price list, so you can let your customer know about anything extra:`,
    '',
    ...rows,
    '',
    `Total: ${money(data.total)} plus GST`,
    '',
    'One invoice follows once the panels are back on. Call us if any of it is not what you expected.',
  ].join('\n');
  return { to: data.clientEmail, subject: `${p.ref}: price after the disconnect at ${p.address || 'the site'}`, bodyText };
}

async function sendPriceEmail(admin, projectId, userId, input) {
  const to = clean(input.to, 300);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+/.test(to)) throw new Refused('The client has no email. Add one, then send.');
  const subject = clean(input.subject, 200);
  const bodyText = clean(input.bodyText, 6000);
  if (!subject || !bodyText) throw new Refused('The email needs a subject and some words.');
  const { sendAsUser } = require('./send-recorded-email');
  await sendAsUser(admin, { userId, to, subject, bodyText, tagProjectId: projectId, tagKind: 'client' });
  const p = await readProject(admin, projectId);
  must(await admin.from('projects').update({ service_state: { ...(p.service_state || {}), price_sent_at: new Date().toISOString() } }).eq('id', projectId).select('id'));
  await log(admin, projectId, 'service_price', `Price after the disconnect emailed to ${to}`);
  return { ok: true };
}

// ---------------------------------------------------------------- the upgrade quote

// The crew said the old system is worth replacing: a draft quote for the homeowner (their own
// client record, the roofer as the referrer), with the sheet's photos copied across and a note for
// Sales with the refit share to allow for. Nothing is sent to anyone.
async function createUpgradeQuote(admin, p, userId, data) {
  const state = p.service_state || {};
  if (state.upgrade_quote_id) return { id: state.upgrade_quote_id };
  const b = p.service_booking || {};
  const homeowner = clean(b.homeowner_name, 120);
  let clientId = null;
  if (homeowner) {
    const made = must(await admin.from('clients').insert({ name: homeowner, phone: clean(b.homeowner_phone, 40) || null, address: p.client_address || null }).select('id').single());
    clientId = made.id;
  }
  const number = must(await admin.rpc('get_next_number_serverside', { counter_name: 'quote' }));
  const settings = must(await admin.from('company_settings').select('default_terms').eq('id', 1).maybeSingle());
  const refit = r2(data.lines.reduce((s, l) => s + l.quantity * l.reconnectUnit, 0));
  const brief = [
    `New solar system to replace the one taken off for the roof work on ${jobRef(p)} (${p.client_name || 'the roofer'}).`,
    `Staff only: the refit is already paid for through ${p.client_name || 'the roofer'}, so take ${money(refit)} ex GST off the install price. Do not show that figure. Put this line on the quote instead: "${UPGRADE_NOTE}"`,
    'The nameplate, cabling, rail and switchboard photos from the disconnect are in Photos.',
  ].join('\n\n');
  const quote = must(await admin.from('projects').insert({
    name: `New solar system: ${p.client_address || p.name || ''}`.slice(0, 120), quote_number: number,
    client_id: clientId, client_name: homeowner || 'Homeowner', client_phone: clean(b.homeowner_phone, 40) || null,
    client_address: p.client_address, client_site_id: null, ...(p.address_parts ? { address_parts: p.address_parts, lat: p.lat, lng: p.lng } : {}),
    proposal_template: 'solar', pipeline_stage: 'draft_quote', status: 'draft', sow_brief: brief, terms_text: (settings && settings.default_terms) || '',
    referrer_client_id: p.client_id || null, created_by: userId,
    service_state: { upgrade_of: p.id, refit_credit: refit },
  }).select('id, quote_number').single());
  const photos = must(await admin.from('project_photos').select('url, caption, staff_id').eq('project_id', p.id));
  if (photos && photos.length) await admin.from('project_photos').insert(photos.map((ph) => ({ project_id: quote.id, url: ph.url, caption: ph.caption, staff_id: ph.staff_id })));
  must(await admin.from('projects').update({ service_state: { ...(must(await admin.from('projects').select('service_state').eq('id', p.id).single()).service_state || {}), upgrade_quote_id: quote.id } }).eq('id', p.id).select('id'));
  await log(admin, p.id, 'service_upgrade', `Old system marked worth replacing: draft quote Q${quote.quote_number} made for ${homeowner || 'the homeowner'}`);
  await log(admin, quote.id, 'service_upgrade', `Made from ${jobRef(p)}'s disconnect sheet. Refit share to allow for: ${money(refit)} ex GST (staff only).`);
  await tell(admin, await officeIds(admin), {
    title: `Q${quote.quote_number}: quote a new system (from ${jobRef(p)})`, body: `The crew says the old system at ${p.client_address || 'the site'} is worth replacing. Draft quote made for ${homeowner || 'the homeowner'}.`,
    link: `/project.html?id=${quote.id}&tab=quote`, dedupe: `service-upgrade:${p.id}`,
  });
  return { id: quote.id, number: quote.quote_number };
}

module.exports = {
  GROUP, DISCONNECT, RECONNECT, UPGRADE_NOTE, Refused,
  pricedLines, serviceCentres, serviceActuals, forceServicePrices,
  setupServiceJob, sheetData, saveSheet, saveAnswer,
  bookingByToken, saveBooking, sendQuestionsEmail, priceEmailDraft, sendPriceEmail, bookingUrl,
};
