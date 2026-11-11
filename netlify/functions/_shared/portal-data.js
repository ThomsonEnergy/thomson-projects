// What the client portal shows (backlog item 74): the lists, one job, and the work so far on a
// do and charge job. Every function takes the scope requirePortalSession worked out
// (_shared/portal-session.js) and returns only whitelisted fields; nothing here reads a table
// without the scope in the query. Called by portal-read.js. Reads only.
//
//   portalOverview(admin, scope) -> { clients, needsYou, jobs, quotes, company }
//   portalProject(admin, scope, projectId) -> the job page, or null when it is not theirs
//   portalWork(admin, scope, projectId) -> work so far (do and charge, money scope only), or null
//
// Money (invoices, hours, prices, purchase orders, the Schedule of Rates) only goes to an email on
// the client record (scope.clients). A job contact (scope.contactJobIds) sees the job's progress,
// bookings, who is on site, shared photos and documents, never money. Staff names are first
// names only. Prices are the client's prices (labour at the Schedule of Rates with their
// agreement, materials at cost plus the stage's markup): our cost price never leaves here.

const { jobActuals } = require('./job-actuals');
const { RULES } = require('./labour-bands');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Someone';
const sydneyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
// the Sydney date of a timestamp (never the UTC date: 9am Sydney is the day before in UTC)
const sydneyKey = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const isVideoUrl = (u) => /\.(mp4|mov|m4v|webm)(\?|$)/i.test(String(u || ''));
const DAY = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' });
const TIME = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Australia/Sydney' });
const dayText = (dateKey) => DAY.format(new Date(`${dateKey}T12:00:00+10:00`));
const timeText = (iso) => TIME.format(new Date(iso)).replace(/\s/g, '').toLowerCase();
const clockText = (t) => { // '07:30:00' -> '7:30am'
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`;
};
const listNames = (names) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
const projectRef = (p) => p.job_number ? `J${p.job_number}` : p.quote_number ? `Q${p.quote_number}` : '';
const PROJECT_COLS = 'id, name, client_id, client_address, status, pipeline_stage, proposal_template, quote_number, job_number, sent_at, quote_token, expired, declined_at, approved_at, completed_at, valid_until, source_quote_id, quote_pdf_path, created_at';
const OPEN_STAGES_DONE = new Set(['complete', 'archived']);

// Every project in the scope: the client's own (money) plus the jobs they are a contact on.
async function scopedProjects(admin, scope) {
  const clientIds = scope.clients.map((c) => c.id);
  const [own, asContact] = await Promise.all([
    clientIds.length ? admin.from('projects').select(PROJECT_COLS).in('client_id', clientIds).neq('status', 'merged') : Promise.resolve({ data: [] }),
    scope.contactJobIds.length ? admin.from('projects').select(PROJECT_COLS).in('id', scope.contactJobIds).neq('status', 'merged') : Promise.resolve({ data: [] }),
  ]);
  const byId = {};
  (own.data || []).forEach((p) => { byId[p.id] = { ...p, money: true }; });
  (asContact.data || []).forEach((p) => { if (!byId[p.id]) byId[p.id] = { ...p, money: false }; });
  return Object.values(byId);
}

// Bookings the client has been told about (client_informed_at set), today or later, with first names.
async function bookingsFor(admin, projectIds, { from, limit } = {}) {
  if (!projectIds.length) return [];
  let q = admin.from('schedule_assignments')
    .select('project_id, assignment_date, start_time, end_time, block_type, profiles(full_name)')
    .in('project_id', projectIds).not('client_informed_at', 'is', null)
    .order('assignment_date').order('start_time');
  if (from) q = q.gte('assignment_date', from);
  if (limit) q = q.limit(limit);
  const { data } = await q;
  // one line per job per day: the people on it
  const byKey = {};
  (data || []).forEach((a) => {
    const key = `${a.project_id}|${a.assignment_date}`;
    byKey[key] ||= { projectId: a.project_id, dateKey: a.assignment_date, day: dayText(a.assignment_date), start: clockText(a.start_time), end: clockText(a.end_time), who: [] };
    const n = firstName(a.profiles?.full_name);
    if (!byKey[key].who.includes(n)) byKey[key].who.push(n);
    if (a.start_time && (!byKey[key].startRaw || a.start_time < byKey[key].startRaw)) { byKey[key].startRaw = a.start_time; byKey[key].start = clockText(a.start_time); }
    if (a.end_time && (!byKey[key].endRaw || a.end_time > byKey[key].endRaw)) { byKey[key].endRaw = a.end_time; byKey[key].end = clockText(a.end_time); }
  });
  return Object.values(byKey).map(({ startRaw, endRaw, ...b }) => b);
}

// Who is clocked in on these jobs right now: clocked in today (Sydney); a clock-out forgotten
// on an earlier day is not "on site now".
async function onSiteFor(admin, projectIds) {
  if (!projectIds.length) return [];
  const { data } = await admin.from('time_entries').select('project_id, clock_in, profiles(full_name)').in('project_id', projectIds).is('clock_out', null).order('clock_in');
  const today = sydneyToday();
  return (data || []).filter((e) => sydneyKey(e.clock_in) === today).map((e) => ({ projectId: e.project_id, who: firstName(e.profiles?.full_name), since: timeText(e.clock_in) }));
}

// Invoices the client has been sent (made but not sent stay hidden), with a plain status word.
async function invoicesFor(admin, projectIds, { onlyOpen } = {}) {
  if (!projectIds.length) return [];
  const { data } = await admin.from('invoices')
    .select('id, project_id, invoice_number, description, sent_at, due_date, paid_at, balance_due, is_deposit, invoice_token, pdf_path, invoice_events(kind)')
    .in('project_id', projectIds).order('sent_at', { ascending: false });
  const today = sydneyToday();
  return (data || [])
    .filter((i) => (i.invoice_events || []).some((e) => e.kind === 'emailed' || e.kind === 'sent_elsewhere'))
    .map((i) => {
      const balance = r2(i.balance_due);
      const paid = !!i.paid_at || balance <= 0;
      const overdue = !paid && i.due_date && i.due_date < today;
      return {
        id: i.id, projectId: i.project_id, number: i.invoice_number, description: i.description || (i.is_deposit ? 'Deposit' : ''),
        sent: i.sent_at ? dayText(sydneyKey(i.sent_at)) : '', due: i.due_date ? dayText(i.due_date) : '', dueKey: i.due_date || '',
        balance, status: paid ? 'paid' : overdue ? 'overdue' : 'awaiting',
        label: paid ? 'Paid' : overdue ? 'Overdue' : 'Awaiting payment',
        url: `/invoice.html?token=${i.invoice_token}`,
      };
    })
    .filter((i) => !onlyOpen || i.status !== 'paid');
}

// The one plain line under a job or quote.
function statusLine(p, { booking, onSite, invoices }) {
  const isJob = !!p.job_number;
  if (!isJob) {
    if (p.status === 'declined' || p.declined_at) return { text: 'Declined', open: false };
    if (p.expired) return { text: 'Quote expired', open: false };
    if (p.status === 'approved' || p.approved_at) return { text: 'Approved', open: false };
    if (p.sent_at) return { text: 'Quote sent, waiting on you', open: true, needsYou: 'Approve your quote' };
    return { text: 'Quote being prepared', open: true };
  }
  const stage = p.pipeline_stage || '';
  if (OPEN_STAGES_DONE.has(stage) || p.status === 'complete') return { text: 'Complete', open: false };
  if (onSite.length) return { text: `On site now: ${listNames(onSite.map((o) => `${o.who} since ${o.since}`))}`, open: true };
  const unpaidDeposit = (invoices || []).find((i) => i.projectId === p.id && i.status !== 'paid' && /deposit/i.test(i.description));
  if (stage === 'awaiting_payment') {
    const overdue = (invoices || []).some((i) => i.projectId === p.id && i.status === 'overdue');
    return { text: overdue ? 'Invoice overdue' : 'Invoice sent', open: true };
  }
  if (stage === 'client_handover' || stage === 'ready_to_invoice') return { text: 'Work finished, invoice to come', open: true };
  if (booking) return { text: `Booked for ${booking.day}${booking.who.length ? `, ${listNames(booking.who)}` : ''}`, open: true };
  if (stage === 'job_not_complete') return { text: 'In progress', open: true };
  if (unpaidDeposit) return { text: 'Approved, deposit to pay', open: true, needsYou: 'Pay the deposit' };
  if (stage === 'job_booked') return { text: 'Booked', open: true };
  return { text: 'Being booked', open: true };
}

function projectRow(p, ctx) {
  const booking = ctx.bookings.find((b) => b.projectId === p.id) || null;
  const onSite = ctx.onSite.filter((o) => o.projectId === p.id);
  const st = statusLine(p, { booking, onSite, invoices: ctx.invoices });
  return {
    id: p.id, ref: projectRef(p), name: p.name, site: p.client_address || '', kind: p.job_number ? 'job' : 'quote',
    status: st.text, open: st.open, money: p.money,
    quoteUrl: !p.job_number && p.sent_at && p.quote_token ? `/quote.html?token=${p.quote_token}` : null,
    needsYou: st.needsYou || null,
  };
}

async function company(admin) {
  const { data } = await admin.from('company_settings').select('company_name, phone, logo_url').eq('id', 1).maybeSingle();
  return { name: data?.company_name || 'Thomson Energy', phone: data?.phone || '', logoUrl: data?.logo_url || '' };
}

async function portalOverview(admin, scope) {
  const projects = await scopedProjects(admin, scope);
  const ids = projects.map((p) => p.id);
  const moneyIds = projects.filter((p) => p.money).map((p) => p.id);
  const [bookings, onSite, invoices, variations, offers, comp] = await Promise.all([
    bookingsFor(admin, ids, { from: sydneyToday() }),
    onSiteFor(admin, ids),
    invoicesFor(admin, moneyIds),
    moneyIds.length ? admin.from('job_variation_entries').select('id, project_id, variation_number, variation_token, description').in('project_id', moneyIds).eq('variation_type', 'fixed').eq('approval_status', 'sent') : Promise.resolve({ data: [] }),
    ids.length ? admin.from('schedule_time_offers').select('id, project_id, token').in('project_id', ids).eq('status', 'open') : Promise.resolve({ data: [] }),
    company(admin),
  ]);
  const ctx = { bookings, onSite, invoices };
  // an approved quote shows as its job, not twice
  const jobsFromQuotes = new Set(projects.map((p) => p.source_quote_id).filter(Boolean));
  const rows = projects.filter((p) => !(jobsFromQuotes.has(p.id) && !p.job_number)).map((p) => projectRow(p, ctx));
  const byRef = (a, b) => (b.ref || '').localeCompare(a.ref || '', undefined, { numeric: true });
  const jobs = rows.filter((r) => r.kind === 'job').sort((a, b) => (a.open === b.open ? byRef(a, b) : a.open ? -1 : 1));
  const quotes = rows.filter((r) => r.kind === 'quote').sort((a, b) => (a.open === b.open ? byRef(a, b) : a.open ? -1 : 1));
  const refOf = (id) => rows.find((r) => r.id === id)?.ref || '';
  const needsYou = [];
  rows.filter((r) => r.needsYou === 'Approve your quote').forEach((r) => needsYou.push({ text: `${r.ref} ${r.name}: your quote is waiting on you`, action: 'Open quote', url: r.quoteUrl }));
  (variations.data || []).forEach((v) => needsYou.push({ text: `${refOf(v.project_id)}: variation ${v.variation_number || ''} to sign`.replace(/\s+/g, ' '), action: 'Open variation', url: `/quote.html?variation=${v.variation_token}` }));
  (offers.data || []).forEach((o) => needsYou.push({ text: `${refOf(o.project_id)}: pick a time that suits you`, action: 'Pick a time', url: `/pick-time.html?token=${o.token}` }));
  invoices.filter((i) => i.status === 'overdue').forEach((i) => needsYou.push({ text: `${i.number} is overdue (${money(i.balance)})`, action: 'Pay online', url: i.url }));
  invoices.filter((i) => i.status === 'awaiting').forEach((i) => needsYou.push({ text: `${i.number}: ${money(i.balance)} due ${i.due}`, action: 'View invoice', url: i.url }));
  return {
    clients: scope.clients.map((c) => ({ id: c.id, name: c.name, main: c.main })),
    needsYou, jobs, quotes, company: comp,
  };
}

const money = (n) => `$${r2(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function scopedProject(admin, scope, projectId) {
  const projects = await scopedProjects(admin, scope);
  return projects.find((p) => p.id === projectId) || null;
}

async function portalProject(admin, scope, projectId) {
  const p = await scopedProject(admin, scope, projectId);
  if (!p) return null;
  const today = sydneyToday();
  const [bookings, past, onSite, invoices, photos, docs, contacts, variations, comp, client] = await Promise.all([
    bookingsFor(admin, [p.id], { from: today }),
    bookingsFor(admin, [p.id]),
    onSiteFor(admin, [p.id]),
    p.money ? invoicesFor(admin, [p.id]) : Promise.resolve([]),
    admin.from('project_photos').select('id, url, caption, created_at').eq('project_id', p.id).eq('client_visible', true).order('created_at', { ascending: false }),
    admin.from('project_documents').select('id, file_path, file_name, mime_type, created_at').eq('project_id', p.id).eq('client_visible', true).order('created_at', { ascending: false }),
    admin.from('job_contacts').select('role, side, profiles!job_contacts_profile_id_fkey(full_name)').eq('project_id', p.id).eq('side', 'thomson'),
    p.money ? admin.from('job_variation_entries').select('id, variation_number, variation_token, description, approval_status, variation_type, pdf_path, created_at').eq('project_id', p.id).eq('variation_type', 'fixed').in('approval_status', ['sent', 'approved']).order('created_at') : Promise.resolve({ data: [] }),
    company(admin),
    p.money ? admin.from('clients').select('id, agreement_token, agreement_sent_at, agreement_withdrawn_at, agreement_document_path, rate_cards(name, percent)').eq('id', p.client_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const st = statusLine(p, { booking: bookings[0] || null, onSite, invoices });
  const manager = (contacts.data || []).find((c) => c.role === 'site_manager') || (contacts.data || []).find((c) => c.role === 'project_manager');

  // Documents: the ticked ones, plus what we have already sent them (the quote PDF once sent,
  // approved variations, the agreement letter). Signed links last an hour.
  const files = (docs.data || []).map((d) => ({ path: d.file_path, name: d.file_name, mime: d.mime_type || '', when: dayText(sydneyKey(d.created_at)) }));
  if (p.money && p.sent_at && p.quote_pdf_path) files.unshift({ path: p.quote_pdf_path, name: `${projectRef(p)} quote.pdf`, mime: 'application/pdf', when: dayText(sydneyKey(p.sent_at)) });
  (variations.data || []).filter((v) => v.approval_status === 'approved' && v.pdf_path).forEach((v) => files.push({ path: v.pdf_path, name: `Variation ${v.variation_number || ''}.pdf`.replace(/\s+\./, '.'), mime: 'application/pdf', when: dayText(sydneyKey(v.created_at)) }));
  const cl = client.data;
  const agreementOn = !!(cl && cl.agreement_sent_at && !cl.agreement_withdrawn_at && cl.agreement_token);
  if (agreementOn && cl.agreement_document_path) files.push({ path: cl.agreement_document_path, name: 'Commercial agreement.pdf', mime: 'application/pdf', when: dayText(sydneyKey(cl.agreement_sent_at)) });
  const signed = files.length ? await admin.storage.from('project-documents').createSignedUrls(files.map((f) => f.path), 3600) : { data: [] };
  const urlByPath = {};
  (signed.data || []).forEach((s) => { if (s.signedUrl && !s.error) urlByPath[s.path] = s.signedUrl; });
  const documents = files.map((f) => ({ name: f.name, mime: f.mime, when: f.when, url: urlByPath[f.path] || null })).filter((f) => f.url);

  const pastBookings = past.filter((b) => b.dateKey < today).slice(-5).reverse();
  return {
    id: p.id, ref: projectRef(p), name: p.name, site: p.client_address || '', kind: p.job_number ? 'job' : 'quote',
    status: st.text, open: st.open, money: p.money,
    direct: p.proposal_template === 'direct_job',
    quoteUrl: !p.job_number && p.sent_at && p.quote_token ? `/quote.html?token=${p.quote_token}` : null,
    manager: manager ? firstName(manager.profiles?.full_name) : null,
    company: comp,
    bookings: bookings.map(({ projectId, ...b }) => b),
    pastBookings: pastBookings.map(({ projectId, ...b }) => b),
    onSite: onSite.map(({ projectId, ...o }) => o),
    photos: (photos.data || []).map((ph) => ({ url: ph.url, caption: ph.caption || '', when: dayText(sydneyKey(ph.created_at)), video: isVideoUrl(ph.url) })),
    documents,
    invoices: invoices.map(({ projectId, ...i }) => i),
    variations: (variations.data || []).map((v) => ({ number: v.variation_number, description: v.description, status: v.approval_status === 'sent' ? 'To sign' : 'Signed', url: v.approval_status === 'sent' ? `/quote.html?variation=${v.variation_token}` : null })),
    ratesUrl: p.money ? (agreementOn ? `/rates.html?agreement=${cl.id}&token=${cl.agreement_token}` : '/rates.html') : null,
    agreement: agreementOn && cl.rate_cards ? { name: cl.rate_cards.name, percentOff: Math.max(0, r2(100 - Number(cl.rate_cards.percent))) } : null,
  };
}

// Work so far on a do and charge job: labour per clocked day at the Schedule of Rates, materials
// at the client's price, purchase orders with their pickup state, and what is not yet invoiced.
async function portalWork(admin, scope, projectId) {
  const p = await scopedProject(admin, scope, projectId);
  if (!p || !p.money || p.proposal_template !== 'direct_job') return null;
  const [actuals, { data: pos }] = await Promise.all([
    jobActuals(admin, p.id, { includeBilled: true }),
    admin.from('purchase_orders').select('id, po_number, supplier_name, status, received, order_date, cost_centre_id, po_kind, purchase_order_line_items(description, quantity, unit_cost, received, is_backordered, backorder_eta)').eq('project_id', p.id).order('order_date', { ascending: false }),
  ]);
  if (!actuals.ok) return { ref: projectRef(p), labour: [], materials: [], purchaseOrders: [], notInvoiced: 0, note: actuals.error };
  const d = actuals.data;
  const bandLabel = (band) => band === 'standard' ? 'standard' : (RULES.bands[band]?.label || band);
  const labour = [];
  d.centres.forEach((c) => c.labourLines.forEach((l) => {
    if (!l.billable && !l.invoiced) return;
    const parts = Object.entries(l.bands).filter(([, h]) => h > 0);
    const amount = parts.reduce((s, [band, h]) => s + h * l.rate * (RULES.bands[band]?.multiplier || 1), 0);
    labour.push({
      dateKey: l.dateKey, day: dayText(l.dateKey), who: firstName(l.staffName), start: l.start, end: l.end,
      hours: r2(l.hours), bands: parts.map(([band, h]) => `${r2(h)} h ${bandLabel(band)}`.replace(/ standard$/, '')).join(', '),
      rate: r2(l.rate), amount: r2(amount), invoiced: l.invoiced, invoiceNumber: l.invoiceNumber,
    });
  }));
  labour.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const materials = [];
  d.centres.forEach((c) => c.materialLines.forEach((m) => {
    if (!m.billable && !m.invoiced) return;
    materials.push({ description: m.description, from: m.from, quantity: m.quantity, unitPrice: m.unitPrice, amount: r2(m.quantity * m.unitPrice), invoiced: m.invoiced, invoiceNumber: m.invoiceNumber, when: m.createdAt ? dayText(sydneyKey(m.createdAt)) : '' });
  }));
  const markupOf = (centreId) => (d.centres.find((c) => c.costCentreId === centreId) || d.centres[0] || { markupPercent: 0 }).markupPercent;
  const purchaseOrders = (pos || []).filter((po) => po.po_kind !== 'tools').map((po) => {
    const m = 1 + markupOf(po.cost_centre_id) / 100;
    const lines = (po.purchase_order_line_items || []).map((l) => ({ description: l.description, quantity: Number(l.quantity) || 0, amount: r2((Number(l.quantity) || 0) * (Number(l.unit_cost) || 0) * m), received: !!l.received, backordered: !!l.is_backordered, eta: l.backorder_eta ? dayText(l.backorder_eta) : '' }));
    const allIn = lines.length ? lines.every((l) => l.received) : !!po.received;
    const someIn = lines.some((l) => l.received);
    return {
      number: po.po_number, supplier: po.supplier_name, ordered: po.order_date ? dayText(po.order_date) : '',
      state: allIn ? 'Picked up' : someIn ? 'Part picked up, rest to come' : lines.some((l) => l.backordered) ? 'Ordered, part on back order' : 'Ordered, waiting for pickup',
      total: r2(lines.reduce((s, l) => s + l.amount, 0)), lines,
    };
  });
  const labourOpen = r2(labour.filter((l) => !l.invoiced).reduce((s, l) => s + l.amount, 0));
  const materialsOpen = r2(materials.filter((m) => !m.invoiced).reduce((s, m) => s + m.amount, 0));
  return {
    ref: projectRef(p), labour, materials, purchaseOrders,
    labourOpen, materialsOpen, notInvoiced: r2(labourOpen + materialsOpen),
    rules: { standardHours: RULES.standardHours, minimumHours: RULES.minimumHours },
    agreement: d.rateCard.percentOff > 0 ? { name: d.rateCard.name, percentOff: d.rateCard.percentOff } : null,
  };
}

module.exports = { portalOverview, portalProject, portalWork };
