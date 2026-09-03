// Fill these in with your own Supabase project values (Settings > API in Supabase).
// The anon key is safe to expose in the browser, it only has the access RLS allows.
const SUPABASE_URL = 'https://ziakpklnzkbbjjnqgkmz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppYWtwa2xuemtiYmpqbnFna216Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTg2OTIsImV4cCI6MjEwMjY3NDY5Mn0.xuEorSGdx9rI_ySM6V4MOxoQLOTD1OCWdrSXKMKnFAE';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function requireLogin() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = '/login.html';
    return null;
  }

  // Every page calls requireLogin() as its first act, so this is the one
  // shared place to force incomplete onboarding to finish before anyone
  // touches the rest of the app - covers all pages without editing each
  // one individually.
  if (!window.location.pathname.endsWith('/onboarding.html')) {
    const { data: profile } = await supabaseClient.from('profiles').select('onboarding_completed_at').eq('id', session.user.id).maybeSingle();
    if (profile && !profile.onboarding_completed_at) {
      window.location.href = '/onboarding.html';
      return null;
    }
  }

  return session;
}

function money(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n || 0);
}

// Uploads a single file to the private project-documents bucket. Returns the
// storage path (not a public URL, this bucket has no public access).
async function uploadPrivateFile(file, folder) {
  const path = `${folder}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { error } = await supabaseClient.storage.from('project-documents').upload(path, file);
  if (error) throw error;
  return path;
}

// Generates a short-lived link to view/download a private document. Call this
// fresh each time, don't store the result, it expires.
async function getSignedDocUrl(path) {
  const { data, error } = await supabaseClient.storage.from('project-documents').createSignedUrl(path, 300);
  if (error) throw error;
  return data.signedUrl;
}

// Uploads one or more files to the public proposal-photos bucket and returns
// their public URLs. `folder` keeps things tidy, e.g. 'portfolio' or a project id.
async function uploadPhotos(fileList, folder) {
  const urls = [];
  for (const file of fileList) {
    const path = `${folder}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { error } = await supabaseClient.storage.from('proposal-photos').upload(path, file);
    if (error) throw error;
    const { data } = supabaseClient.storage.from('proposal-photos').getPublicUrl(path);
    urls.push(data.publicUrl);
  }
  return urls;
}

// Renders a small thumbnail strip with remove buttons into `containerEl`,
// keeping `photosArray` (array of URL strings) in sync.
function renderPhotoThumbs(containerEl, photosArray, onChange) {
  containerEl.innerHTML = photosArray.map((url, i) => `
    <div style="position:relative; display:inline-block; margin:0 8px 8px 0;">
      <img src="${url}" style="width:90px; height:90px; object-fit:cover; border-radius:8px; border:1px solid var(--border);" />
      <button type="button" data-i="${i}" class="thumb-remove" style="position:absolute; top:-6px; right:-6px; width:20px; height:20px; padding:0; border-radius:50%; font-size:11px; line-height:1;">x</button>
    </div>
  `).join('');
  containerEl.querySelectorAll('.thumb-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      photosArray.splice(parseInt(btn.dataset.i), 1);
      renderPhotoThumbs(containerEl, photosArray, onChange);
      onChange && onChange();
    });
  });
}

// Returns the logged-in user's role (admin/finance/sales/staff), cached
// for the life of the page. Defaults to the safest option, 'staff', if
// anything goes wrong - better to under-show pricing than leak it.
let _cachedRole = null;
async function getMyRole() {
  if (_cachedRole) return _cachedRole;
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return 'staff';
  const { data } = await supabaseClient
    .from('profiles')
    .select('role')
    .eq('id', session.user.id)
    .maybeSingle();
  _cachedRole = data?.role || 'staff';
  return _cachedRole;
}

function isPricingRole(role) {
  return role === 'admin' || role === 'finance' || role === 'sales';
}

// The two cost_centres column lists used across the app when embedding
// via a projects query. Pricing columns are only requested for roles that
// are actually allowed to see them - the database also enforces this via
// column-level grants (see migration_007), so a role-check bug here can't
// by itself leak pricing.
const COST_CENTRE_COLS_BASE = 'id, project_id, name, description, sort_order';
const COST_CENTRE_COLS_PRICING = 'markup_percent, quoted_amount, estimated_labour_cost, estimated_material_cost, labour_cost, material_cost, invoiced_amount, stc_total';
const LINE_ITEM_COLS_BASE = 'id, cost_centre_id, description, item_type, sort_order, quantity';
const LINE_ITEM_COLS_PRICING = 'unit_cost';

async function costCentreColumns() {
  const role = await getMyRole();
  return isPricingRole(role) ? `${COST_CENTRE_COLS_BASE}, ${COST_CENTRE_COLS_PRICING}` : COST_CENTRE_COLS_BASE;
}

async function lineItemColumns() {
  const role = await getMyRole();
  return isPricingRole(role) ? `${LINE_ITEM_COLS_BASE}, ${LINE_ITEM_COLS_PRICING}` : LINE_ITEM_COLS_BASE;
}

// For display: tells a null pricing value (masked by role) apart from a
// genuine $0. Use instead of money() wherever a value might be masked.
function moneyOrHidden(n) {
  return (n === null || n === undefined) ? ' - ' : money(n);
}

// Wraps a plain address string as a link that opens it in Google Maps in a
// new tab - a plain maps search URL, no API key needed (unlike the Places
// Autocomplete used on the address input fields). Returns '' for a falsy
// address so it drops out cleanly of .filter(Boolean).join(...) patterns.
// stopPropagation guards against the many places an address sits inside a
// whole-row click handler (e.g. a client list row that opens on click) -
// without it, clicking the address would both open Maps and trigger
// whatever the row itself does.
function mapsLink(address) {
  if (!address) return '';
  return `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}" target="_blank" rel="noopener" class="link-quiet" onclick="event.stopPropagation()">${address}</a>`;
}

// Dev Mode - a time-limited unlock (20 min) for the most dangerous admin
// actions (API keys, company details, Xero mapping, bulk-delete). The
// password is verified server-side by verify-dev-mode.js, never shipped to
// the browser - this is a UI-layer gate, same trust level as the rest of
// this app's admin-only tabs, not a database-level enforcement.
const DEV_MODE_STORAGE_KEY = 'te-dev-mode-expires';

function isDevModeActive() {
  const exp = parseInt(localStorage.getItem(DEV_MODE_STORAGE_KEY) || '0', 10);
  return exp > Date.now();
}

function devModeMinutesRemaining() {
  const exp = parseInt(localStorage.getItem(DEV_MODE_STORAGE_KEY) || '0', 10);
  return Math.max(0, Math.ceil((exp - Date.now()) / 60000));
}

function setDevModeExpiry(expiresAt) {
  localStorage.setItem(DEV_MODE_STORAGE_KEY, String(expiresAt));
}

function clearDevMode() {
  localStorage.removeItem(DEV_MODE_STORAGE_KEY);
}

// Shared across the Suppliers and supplier-detail pages - both need to
// read a file for AI extraction and fuzzy-match text against existing
// records, so these live here once rather than being copy-pasted twice.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function fuzzyMatchScore(a, b) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const wordsA = new Set(norm(a));
  const wordsB = norm(b);
  if (!wordsA.size || !wordsB.length) return 0;
  const matches = wordsB.filter(w => wordsA.has(w)).length;
  return matches / Math.max(wordsA.size, wordsB.length);
}

// Given fields pulled off an uploaded document, finds the best matching
// existing supplier - checked in the order real invoices proved most
// reliable: their account number for us (the same MMEM account shows
// different logos across Haymans/Greentech/TLE but an identical "Charge
// To" number), then ABN, then their own bank details, and only as a
// last resort, fuzzy business name matching. Returns null if nothing
// matches confidently enough - the caller should offer to create a new
// supplier rather than silently guessing wrong.
async function findMatchingSupplier(fields) {
  const { name, ourAccountNumber, abn, bsb, bankAccountNumber } = typeof fields === 'string' ? { name: fields } : fields;
  const { data: suppliers } = await supabaseClient.from('suppliers').select('*');
  const list = suppliers || [];

  if (ourAccountNumber) {
    const match = list.find(s => s.our_account_number && s.our_account_number.trim() === String(ourAccountNumber).trim());
    if (match) return match;
  }
  if (abn) {
    const normalizedAbn = String(abn).replace(/\s/g, '');
    const match = list.find(s => s.abn && s.abn.replace(/\s/g, '') === normalizedAbn);
    if (match) return match;
  }
  if (bsb && bankAccountNumber) {
    const match = list.find(s => s.bsb === bsb && s.bank_account_number === bankAccountNumber);
    if (match) return match;
  }

  let best = null, bestScore = 0;
  list.forEach(s => {
    const score = fuzzyMatchScore(s.name, name);
    if (score > bestScore) { bestScore = score; best = s; }
  });
  return bestScore >= 0.5 ? best : null;
}

// Single source of truth for the main nav - every page calls
// renderMainNav('key') into empty <nav id="topbar-tabs"> and
// <div id="mobile-menu-dropdown"> containers, instead of each page
// hand-maintaining its own copy of the same 13 links (which is exactly
// how small nav inconsistencies kept creeping in before this existed).
const MAIN_NAV_ITEMS = [
  { key: 'my-day', label: 'My Day', href: '/my-day.html' },
  { key: 'leads', label: 'Leads', href: '/leads.html' },
  { key: 'quotes', label: 'Quotes', href: '/quotes.html' },
  { key: 'projects', label: 'Projects', href: '/projects.html' },
  { key: 'job-pipeline', label: 'Job pipeline', href: '/dashboard.html' },
  { key: 'invoices', label: 'Invoices', href: '/invoices.html' },
  { key: 'purchase-orders', label: 'Purchase Orders', href: '/purchase-orders.html' },
  { key: 'tasks', label: 'Tasks', href: '/tasks.html' },
  { key: 'suppliers', label: 'Suppliers', href: '/suppliers.html' },
  { key: 'timesheets', label: 'Timesheets', href: '/timesheets.html' },
  { key: 'clients', label: 'Clients', href: '/clients.html' },
  { key: 'stock', label: 'Stock', href: '/stock.html' },
  { key: 'team', label: 'Team', href: '/team.html' },
  { key: 'dnsp', label: 'DNSP', href: '/dnsp.html' },
  { key: 'fleet', label: 'Fleet', href: '/fleet.html' },
];

function renderMainNav(activeKey) {
  const tabsEl = document.getElementById('topbar-tabs');
  const dropdownEl = document.getElementById('mobile-menu-dropdown');
  const linksHtml = (asTab) => MAIN_NAV_ITEMS.map(item =>
    `<a href="${item.href}" class="${asTab ? 'topbar-tab' : ''} ${item.key === activeKey ? 'active' : ''}">${item.label}</a>`
  ).join('');
  if (tabsEl) tabsEl.innerHTML = linksHtml(true);
  if (dropdownEl) dropdownEl.innerHTML = linksHtml(false);
}

// Shared job search - by job number, name, client name, or site address.
// Used by the Schedule day view's draggable job panel, the Timesheets job
// picker, and anywhere else that needs "find a job by anything about it."
async function searchProjects(query, limit = 15) {
  if (!query || query.trim().length < 2) return [];
  const q = query.trim();
  const isNumeric = /^\d+$/.test(q);
  const orClauses = [`name.ilike.%${q}%`, `client_name.ilike.%${q}%`, `client_address.ilike.%${q}%`];
  if (isNumeric) orClauses.push(`job_number.eq.${q}`, `quote_number.eq.${q}`);
  const { data, error } = await supabaseClient
    .from('projects')
    .select('id, name, job_number, quote_number, client_name, client_address, pipeline_stage')
    .or(orClauses.join(','))
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('searchProjects error:', error.message); return []; }
  return data || [];
}

// Opens Gmail's own compose window directly, rather than whatever the
// browser/OS decides is the "default" mail app for a plain mailto: link -
// most people using Gmail actually use it in the browser, not a desktop
// mail client, so mailto: often opens the wrong thing entirely.
function gmailComposeUrl({ to = '', subject = '', body = '' } = {}) {
  const params = new URLSearchParams({ view: 'cm', fs: '1', to, su: subject, body });
  return `https://mail.google.com/mail/?${params.toString()}`;
}

// Cost centre numbers (e.g. "7000-2") are computed from the job number
// plus the stage's position, not stored - position is 1-indexed.
function costCentreNumber(jobNumber, position) {
  return jobNumber ? `J${jobNumber}-${position}` : `-${position}`;
}

// Splits a clock-in/clock-out pair into one segment per Sydney calendar
// day, so a shift that runs past midnight never lands as a single
// time_entries row spanning two days - both the "your timesheet this
// week" view and the server-side labour-cost banding key everything off
// the Sydney LOCAL date of a row, so a row that crosses midnight would
// otherwise have its hours entirely misattributed to whichever day it
// started on. Returns [{clock_in, clock_out}, ...] as ISO strings - a
// same-day shift returns a single segment matching the input exactly.
function sydneyOffsetMinutesAt(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', timeZoneName: 'shortOffset' }).formatToParts(date);
  const tzPart = parts.find(p => p.type === 'timeZoneName');
  const m = tzPart && tzPart.value.match(/GMT([+-]\d+)/);
  return m ? parseInt(m[1], 10) * 60 : 600;
}
function sydneyDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function sydneyMidnightUtc(dateKey) {
  const naive = new Date(`${dateKey}T00:00:00Z`);
  return new Date(naive.getTime() - sydneyOffsetMinutesAt(naive) * 60000);
}
function splitAtSydneyMidnight(clockInIso, clockOutIso) {
  const segments = [];
  let cursor = new Date(clockInIso);
  const end = new Date(clockOutIso);
  while (cursor < end) {
    const dateKey = sydneyDateKey(cursor);
    const nextDateKey = new Date(`${dateKey}T00:00:00Z`);
    nextDateKey.setUTCDate(nextDateKey.getUTCDate() + 1);
    const nextMidnight = sydneyMidnightUtc(nextDateKey.toISOString().slice(0, 10));
    const segEnd = nextMidnight < end ? nextMidnight : end;
    segments.push({ clock_in: cursor.toISOString(), clock_out: segEnd.toISOString() });
    cursor = segEnd;
  }
  return segments.length ? segments : [{ clock_in: clockInIso, clock_out: clockOutIso }];
}

// STC (Small-scale Technology Certificate) quantity, per the Clean Energy
// Regulator's published formula (cer.gov.au/schemes/renewable-energy-target
// /small-scale-renewable-energy-scheme/small-scale-technology-certificates):
// system size (kW) x postcode zone rating x deeming years, rounded down.
// Deeming years = years remaining until the scheme ends in 2030 inclusive -
// a system installed in year Y is deemed for (2031 - Y) years (2026 -> 5,
// 2030 -> 1, per the Regulator's own worked examples).
//
// Zone rating is a manual pick, not looked up from the address - the
// Regulator's postcode-to-zone table is only published as a PDF, not
// something this can reliably parse. Zone 3 covers the whole east coast
// from about Sydney to Brisbane/the Gold Coast (i.e. this business's own
// service area), so it's the sane default; only override it for a job
// genuinely outside that band.
const STC_ZONES = [
  { rating: 1.622, label: 'Zone 1 (far north QLD/NT/WA)' },
  { rating: 1.536, label: 'Zone 2' },
  { rating: 1.382, label: 'Zone 3 (most of the east coast - Sydney to Brisbane/Gold Coast)' },
  { rating: 1.185, label: 'Zone 4 (Tasmania, far south NSW/VIC coast)' },
];

function stcDeemingYears(installYear) {
  return Math.max(0, 2031 - (installYear || new Date().getFullYear()));
}

function calculateStcQuantity({ kw, zoneRating, installYear }) {
  const deemingYears = stcDeemingYears(installYear);
  if (!kw || !zoneRating || !deemingYears) return 0;
  return Math.floor(kw * zoneRating * deemingYears);
}

// Every field the contract needs that ISN'T already a profile fact -
// letter date, position, hours/days actually worked, and the few dollar
// figures the app's own banded overtime rates don't map onto directly.
// Shown as an actual form in the admin's contract generator, not left as
// raw [bracket] text to hand-edit.
const CONTRACT_ANSWER_FIELDS = [
  { key: 'letter_date', label: 'Letter date', type: 'date' },
  { key: 'position', label: 'Position / job title', type: 'text' },
  { key: 'location_of_work', label: 'Location of work', type: 'text' },
];

function contractHoursFields(employmentType) {
  if (employmentType === 'full_time') {
    return [
      { key: 'hours_days_count', label: 'Days worked per week (number)', type: 'text', placeholder: 'e.g. 5' },
      { key: 'hours_day_from', label: 'Spread of hours - from day', type: 'text', placeholder: 'e.g. Monday' },
      { key: 'hours_day_to', label: 'Spread of hours - to day', type: 'text', placeholder: 'e.g. Friday' },
    ];
  }
  if (employmentType === 'part_time') {
    return [
      { key: 'hours_per_week', label: 'Hours per week', type: 'text', placeholder: 'e.g. 25' },
      { key: 'hours_time_from', label: 'Spread of hours - from time', type: 'text', placeholder: 'e.g. 8:00am' },
      { key: 'hours_time_to', label: 'Spread of hours - to time', type: 'text', placeholder: 'e.g. 4:00pm' },
      { key: 'hours_day_from', label: 'Spread of hours - from day', type: 'text', placeholder: 'e.g. Tuesday' },
      { key: 'hours_day_to', label: 'Spread of hours - to day', type: 'text', placeholder: 'e.g. Thursday' },
    ];
  }
  // casual
  return [
    { key: 'hours_day_from', label: 'Rostered day range - from', type: 'text', placeholder: 'e.g. Monday' },
    { key: 'hours_day_to', label: 'Rostered day range - to', type: 'text', placeholder: 'e.g. Sunday' },
  ];
}

function contractPayFields(profile) {
  if (profile.pay_type === 'salary') {
    return profile.salary_includes_super
      ? [{ key: 'salary_super_component', label: 'Super component of annual salary ($)', type: 'number' }]
      : [];
  }
  return [
    { key: 'travel_allowance_per_day', label: 'Travel allowance ($/day, if required to work away)', type: 'number' },
  ];
}

function money2(n) { return (Number(n) || 0).toFixed(2); }

function buildRemunerationClause(profile, answers) {
  const rate = (n) => (n !== null && n !== undefined && n !== '') ? money2(n) : '[insert pay rate]';
  if (profile.employment_type === 'casual') {
    return `4. Remuneration
4.1 You will be paid an hourly rate of $${rate(profile.ordinary_rate)} (Hourly Rate).
4.2 The Hourly Rate is inclusive of an applicable casual loading amount of twenty-five (25) per cent of the Hourly Rate (Casual Loading Amount).
4.3 The Casual Loading Amount is to compensate you for not having one or more of the following entitlements: (a) paid annual leave; (b) paid personal / carer's leave; (c) paid compassionate leave; (d) payment for absence on a public holiday; (e) payment in lieu of notice of termination; and/or (f) redundancy pay.
4.4 Subject to the Terms, this is the total remuneration paid to you.
4.5 You may also be entitled to other payments, including: penalty rates, overtime, special rates and allowances (if applicable), in accordance with any applicable modern award.
4.6 The remuneration payable under these Terms (including any allowances) is intended to satisfy all entitlements to which you are or may become entitled in respect of the performance of work, under these Terms, any applicable modern award and/or the Fair Work Act 2009 (Cth) (Act).
4.7 The remuneration payable under these Terms (including any allowances) may be specifically set-off against, applied to and may otherwise absorb any existing or newly-introduced payments or benefits to which you are or may become entitled under these Terms, any applicable modern award and/or the Act, including but not limited to, minimum wage rates, overtime and penalty rates, annual leave and other loadings, weekend and other penalty rates, allowances and any other monetary entitlement which may otherwise be payable to you.`;
  }

  const isPartTime = profile.employment_type === 'part_time';
  let payClause;
  if (profile.pay_type === 'salary') {
    const total = Number(profile.annual_salary) || 0;
    if (profile.salary_includes_super) {
      const superPortion = Number(answers.salary_super_component) || 0;
      payClause = `4.1 $${money2(total)} per annum made up of superannuation contributions of $${money2(superPortion)} and the balance of $${money2(total - superPortion)} as cash payments (Annual Salary).`;
    } else {
      payClause = `4.1 You will be paid an annual base salary of $${money2(total)} (Annual Salary).`;
    }
    if (isPartTime) {
      payClause += `\n4.2 For the avoidance of doubt, you will be paid the appropriate pro-rata portion of the Annual Salary, according to the part-time hours that you work.`;
    }
  } else {
    payClause = `4.1 You will be paid an hourly rate of $${rate(profile.ordinary_rate)} (Ordinary Hourly Rate) for the first eight (8) hours worked on any day, Monday to Friday.
4.2 For the next two (2) hours worked on a weekday beyond the first eight (8) hours, you will be paid an hourly rate of $${rate(profile.rate_1_5x)} (Overtime Rate 1).
4.3 For any further hours worked on a weekday beyond that, you will be paid an hourly rate of $${rate(profile.rate_2x)} (Overtime Rate 2).
4.4 For work performed on a Saturday, you will be paid the Overtime Rate 1 for the first four (4) hours worked and the Overtime Rate 2 for any hours worked after that.
4.5 For work performed on a Sunday, you will be paid the Overtime Rate 2 for all hours worked.
4.6 For work performed on a public holiday, you will be paid an hourly rate of $${rate(profile.rate_2_5x)} (Public Holiday Rate) for all hours worked.
4.7 Where you are required to work away from your usual place of residence such that, in the Employer's reasonable opinion, it is not practicable for you to return home at the end of the working day, the Employer will arrange and pay for reasonable and suitable accommodation for the duration of the assignment. You will also be paid a travel allowance of $${rate(answers.travel_allowance_per_day)} per day, including for the purpose of covering meals while you are required to work away from home.
4.8 You may also be entitled to other payments, including: penalty rates, special rates, allowances and annual leave loading (if applicable) (Other Payments).
4.9 For the avoidance of doubt, Other Payments are calculated based on the rate that may apply to you specified in the applicable modern award (if any).`;
  }

  return `4. Remuneration
${payClause}
4.10 Subject to the Terms, this is the total remuneration paid to you.
4.11 The remuneration payable under these Terms (including any allowances) is intended to satisfy all entitlements to which you are or may become entitled in respect of the performance of work, under these Terms, any applicable modern award and/or the Fair Work Act 2009 (Cth) (Act).
4.12 The remuneration payable under these Terms (including any allowances) may be specifically set-off against, applied to and may otherwise absorb any existing or newly-introduced payments or benefits to which you are or may become entitled under these Terms, any applicable modern award and/or the Act, including but not limited to, minimum wage rates, overtime and penalty rates, annual leave and other loadings, weekend and other penalty rates, allowances and any other monetary entitlement which may otherwise be payable to you.`;
}

function buildSuperannuationClause(profile) {
  const standard = `5. Superannuation
In addition to your remuneration set out in clause 4, you will receive superannuation contributions in line with the minimum compulsory contribution rate required to be paid by the Employer, in accordance with applicable legislation.`;
  if (profile.pay_type !== 'salary') return standard;
  return profile.salary_includes_super
    ? `5. Superannuation
The superannuation contribution will be deducted from the Annual Salary. In the event that the amount of superannuation contribution required to be paid by law increases then the increased amount will be deducted from the Annual Salary.`
    : standard;
}

function buildTerminationClause(profile) {
  const isCasual = profile.employment_type === 'casual';
  const byYouClause = isCasual
    ? 'You may terminate your employment with the Employer at any time, effective at the end of your current engagement.'
    : "You may terminate your employment with the Employer by giving two (2) weeks' notice in writing to the Employer.";
  const byEmployerNoticeClause = isCasual
    ? 'Your employment may be terminated by the Employer at any time, effective at the end of your current engagement.'
    : `The Employer may terminate your employment with the Employer in accordance with the following table:
Employee's period of continuous service with the Employer on termination / Period
Not more than 1 year / 1 week
More than 1 year but not more than 3 years / 2 weeks
More than 3 years but not more than 5 years / 3 weeks
More than 5 years / 4 weeks
The period specified above will be increased by one (1) week if you are 45 years of age or over and have completed at least two (2) years of continuous service with the Employer.`;
  return `16. Termination of employment
16.1 Termination by You
${byYouClause}
16.2 Termination by the Employer upon giving notice
${byEmployerNoticeClause}
16.3 By the Employer without notice
The Employer may terminate your employment, effective immediately and without payment of any notice, where at any time, and provided always that procedural fairness has been followed, the Employer forms the view that you: (a) have committed any act of wilful or serious misconduct; (b) are in breach of any of the Terms; or (c) are continually or significantly neglectful of your Duties.`;
}

// Auto-fills the employment contract template's [bracket] placeholders
// and resolves every full-time/part-time/casual alternation - always an
// ADMIN-REVIEWED DRAFT, never shown to the employee directly. The
// Remuneration/Superannuation/Termination sections nest alternatives too
// deeply to safely auto-detect from the raw text, so those three are
// synthesized directly from explicit answers (buildRemunerationClause
// etc. above) rather than parsed out of the template - deterministic by
// construction instead of guessed from bracket position.
function generateContractDraft(profile, templateBody, answers = {}) {
  const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  const employmentLabel = { full_time: 'full-time', part_time: 'part-time', casual: 'casual' }[profile.employment_type] || '[full-time / part-time / casual]';

  const lines = templateBody.split('\n');
  const out = [];
  let mode = null; // null = no active alternation (always include); true/false = current selection
  for (const raw of lines) {
    const tag = raw.trim().toLowerCase();
    if (tag === '[for existing permanent part-time and full-time employees]') { mode = false; continue; }
    if (tag === '[for all new employees]') { mode = true; continue; }
    if (tag === '[for full-time employees]') { mode = profile.employment_type === 'full_time'; continue; }
    if (tag === '[for part-time employees]') { mode = profile.employment_type === 'part_time'; continue; }
    if (tag === '[for casual employees]') { mode = profile.employment_type === 'casual'; continue; }
    if (tag === '[for full-time and part-time employees]' || tag === '[for full-time or part-time employees]') { mode = profile.employment_type !== 'casual'; continue; }
    if (tag === '[end options]' || tag === '[end of options]') { mode = null; continue; }
    if (mode === false) continue;

    let line = raw;
    if (line.includes('[insert for Hourly Rate employees, otherwise delete]')) {
      if (profile.pay_type !== 'hourly') continue;
      line = line.replace('[insert for Hourly Rate employees, otherwise delete] ', '');
    }
    if (line.includes('[insert for Annual Salary Employees, otherwise delete]')) {
      if (profile.pay_type !== 'salary') continue;
      line = line.replace('[insert for Annual Salary Employees, otherwise delete] ', '');
    }
    out.push(line);
  }
  let body = out.join('\n');

  // Whole-clause toggles: removed as contiguous ranges rather than
  // same-vs-alternative pairs, since the template marks them as a single
  // clause to delete-if-not-applicable, not a choice between two texts.
  if (!profile.has_company_vehicle) {
    body = body.replace(/7\. Fully Maintained Company Vehicle[\s\S]*?(?=\n8\. Apparel)/, '');
  }
  if (!profile.has_probationary_period) {
    body = body.replace(/2\.2 Probation[\s\S]*?(?=\n3\. Hours of Work)/, '');
  }

  // The three structurally-tangled sections get replaced wholesale with
  // freshly-synthesized text instead of edited in place.
  body = body.replace(/4\. Remuneration[\s\S]*?(?=\n5\. Superannuation)/, buildRemunerationClause(profile, answers) + '\n\n');
  body = body.replace(/5\. Superannuation[\s\S]*?(?=\n6\. Expenses)/, buildSuperannuationClause(profile) + '\n\n');
  body = body.replace(/16\. Termination of employment[\s\S]*?(?=\n17\. Fair Work Information Statement)/, buildTerminationClause(profile) + '\n\n');

  if (profile.employment_type === 'full_time') {
    body = body.replaceAll('[insert number of days]', answers.hours_days_count || '[insert number of days]');
    body = body.replaceAll('[insert day] to [insert day]', `${answers.hours_day_from || '[insert day]'} to ${answers.hours_day_to || '[insert day]'}`);
  } else if (profile.employment_type === 'part_time') {
    body = body.replaceAll('[insert amount] hours per week', `${answers.hours_per_week || '[insert amount]'} hours per week`);
    body = body.replaceAll('[insert time] and [insert time]', `${answers.hours_time_from || '[insert time]'} and ${answers.hours_time_to || '[insert time]'}`);
    body = body.replaceAll('[insert day] to [insert day]', `${answers.hours_day_from || '[insert day]'} to ${answers.hours_day_to || '[insert day]'}`);
  } else if (profile.employment_type === 'casual') {
    body = body.replaceAll('[insert day] to [insert day]', `${answers.hours_day_from || '[insert day]'} to ${answers.hours_day_to || '[insert day]'}`);
  }

  const employeeAddress = profile.residential_address || '[insert employee address]';
  const position = answers.position || '[insert position]';
  const commencementDate = fmtDate(profile.employment_start_date);
  const letterDate = fmtDate(answers.letter_date);

  body = body
    .replaceAll('[insert Thomson Energy Australia Pty Ltd ACN 689 985 831 letterhead]', 'Thomson Energy Australia Pty Ltd\nACN 689 985 831')
    .replaceAll('[insert employee name]', profile.full_name || '[insert employee name]')
    .replaceAll('[insert employee]', profile.full_name || '[insert employee]')
    .replaceAll('[insert employee address]', employeeAddress)
    .replaceAll('[insert position]', position)
    .replaceAll('[full-time / part-time / casual]', employmentLabel)
    .replaceAll('[insert location of work]', answers.location_of_work || '[insert location of work]')
    .replaceAll('is [insert date] (Commencement Date)', commencementDate ? `is ${commencementDate} (Commencement Date)` : 'is [insert date] (Commencement Date)')
    .replace('[insert date]', letterDate || '[insert date]'); // the one remaining occurrence: the letter's own date, at the top

  return body;
}

// Turns a project's raw pylon_data (the attributes object pulled from
// Pylon's solar_designs API - see netlify/functions/pylon-sync.js) into a
// one-line plain-text hardware summary, e.g. "10.56kW system - 24x Longi
// LR5-54HTH 440W - 1x SolarEdge SE10000H - 1x Tesla Powerwall 2 13.5kWh".
// Pylon's API doesn't expose production/ROI figures at all, only hardware
// counts, so that's all this can ever show - the full interactive design
// and ROI calc still lives behind the Pylon link itself.
function pylonSystemSummary(pylonData) {
  if (!pylonData || typeof pylonData !== 'object') return '';
  const parts = [];
  if (pylonData.summary?.dc_output_kw) parts.push(`${pylonData.summary.dc_output_kw}kW system`);
  [...(pylonData.module_types || []), ...(pylonData.inverter_types || []), ...(pylonData.storage_types || [])]
    .forEach(item => { if (item?.description) parts.push(`${item.quantity || 1}x ${item.description}`); });
  return parts.join(' &middot; ');
}

// Kicks off a background extraction function and polls the resulting job
// row until it's done. Used for pricelist/statement extraction, which can
// genuinely run past a normal function's ~10s ceiling for a long document.
async function runBackgroundExtraction(jobType, functionName, file, mediaType) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  const { data: job, error: jobErr } = await supabaseClient.from('ai_extraction_jobs').insert({
    job_type: jobType, status: 'pending', created_by: user.id,
  }).select('id').single();
  if (jobErr) throw jobErr;

  // Background Functions cap request payloads at 256KB - nowhere near
  // enough for a base64-encoded PDF, even a small one. Upload the file to
  // storage first and pass only the path (a short string), then the
  // background function downloads it itself server-side. This is also
  // what removes any real size ceiling on what can be uploaded at all.
  const filePath = await uploadPrivateFile(file, 'ai-extraction-uploads');

  const { data: { session } } = await supabaseClient.auth.getSession();

  let triggerRes;
  try {
    triggerRes = await fetch(`/.netlify/functions/${functionName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ jobId: job.id, filePath, mediaType }),
    });
  } catch (networkErr) {
    throw new Error(`Couldn't reach the extraction service: ${networkErr.message}`);
  }

  if (triggerRes.status !== 202) {
    const text = await triggerRes.text().catch(() => '');
    throw new Error(`The extraction didn't start (status ${triggerRes.status}). ${text || 'Check the function is deployed.'}`);
  }

  const maxAttempts = 60; // ~3 minutes at 3s intervals - a genuinely stuck job should surface an error well before this
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const { data: row } = await supabaseClient.from('ai_extraction_jobs').select('*').eq('id', job.id).single();
    if (row?.status === 'complete') return row.result;
    if (row?.status === 'failed') throw new Error(row.error || 'Extraction failed');
  }
  throw new Error('This is taking longer than expected - try again shortly.');
}

// Shared between the Suppliers page and the Stock page's "Upload
// pricelist" button - given a document's extracted supplier info, either
// confirms a match, lets the person pick manually, or creates a brand
// new supplier automatically, then hands off to that supplier's own page
// with the extraction already done (no re-uploading, no re-running AI).
async function resolveSupplierAndHandoff(extracted, uploadType, extractedPayload, file) {
  const matchFields = {
    name: extracted.supplier || extracted, // bills/statements pass the object, pricelist passes just the name string
    ourAccountNumber: extracted.our_account_number,
    abn: extracted.abn,
    bsb: extracted.bsb,
    bankAccountNumber: extracted.bank_account_number,
  };
  const extractedSupplierName = matchFields.name;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px;';
  overlay.innerHTML = `<div class="card" style="max-width:420px; width:100%;"><p class="subtitle">Working out which supplier this is...</p></div>`;
  document.body.appendChild(overlay);

  const match = await findMatchingSupplier(matchFields);
  const fileBase64 = await fileToBase64(file);

  function proceedTo(supplierId) {
    sessionStorage.setItem('pending_upload', JSON.stringify({
      type: uploadType, extracted: extractedPayload, fileBase64, fileName: file.name, fileType: file.type,
    }));
    window.location.href = `/supplier-detail.html?id=${supplierId}&resume_upload=1`;
  }

  if (match) {
    overlay.querySelector('.card').innerHTML = `
      <h2>Is this ${match.name}?</h2>
      <p class="subtitle" style="margin-bottom:14px;">${matchFields.ourAccountNumber ? `Matched by account number ${matchFields.ourAccountNumber}.` : (matchFields.abn ? `Matched by ABN.` : `The document says "${extractedSupplierName}".`)}</p>
      <button id="rs-yes-btn">Yes, that's ${match.name}</button>
      <button type="button" class="secondary" id="rs-no-btn">No, pick a different supplier</button>`;
    overlay.querySelector('#rs-yes-btn').addEventListener('click', () => proceedTo(match.id));
    overlay.querySelector('#rs-no-btn').addEventListener('click', () => showManualPick());
  } else {
    showNewSupplierPrompt();
  }

  async function showManualPick() {
    const { data: suppliers } = await supabaseClient.from('suppliers').select('id, name').order('name');
    overlay.querySelector('.card').innerHTML = `
      <h2>Pick the supplier</h2>
      <select id="rs-manual-select"><option value="">-- Select --</option>${(suppliers || []).map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
      <p class="subtitle" style="margin:10px 0;">Or</p>
      <button type="button" class="secondary" id="rs-new-instead-btn">This is actually a new supplier</button>
      <div style="margin-top:14px;"><button id="rs-manual-continue-btn">Continue</button></div>`;
    overlay.querySelector('#rs-new-instead-btn').addEventListener('click', () => showNewSupplierPrompt());
    overlay.querySelector('#rs-manual-continue-btn').addEventListener('click', () => {
      const id = overlay.querySelector('#rs-manual-select').value;
      if (id) proceedTo(id);
    });
  }

  async function showNewSupplierPrompt() {
    overlay.querySelector('.card').innerHTML = `<h2>Creating supplier</h2><p class="subtitle">Setting up "${extractedSupplierName}" - you can add or adjust anything anytime from their page.</p>`;
    const { data: created, error } = await supabaseClient.from('suppliers').insert({
      name: extractedSupplierName || 'Unknown supplier',
      credit_terms_type: 'net_days',
      credit_terms_days: 30,
      our_account_number: matchFields.ourAccountNumber || null,
      abn: matchFields.abn || null,
      contact_phone: extracted.contact_phone || null,
      contact_email: extracted.contact_email || null,
      bank_account_name: extracted.bank_account_name || null,
      bsb: matchFields.bsb || null,
      bank_account_number: matchFields.bankAccountNumber || null,
      bpay_biller_code: extracted.bpay_biller_code || null,
      bpay_reference: extracted.bpay_reference || null,
    }).select('id').single();
    if (error) {
      overlay.querySelector('.card').innerHTML = `<h2>Couldn't create the supplier</h2><div class="error-box">${error.message}</div><button type="button" class="secondary" id="rs-new-err-close">Close</button>`;
      overlay.querySelector('#rs-new-err-close').addEventListener('click', () => overlay.remove());
      return;
    }
    proceedTo(created.id);
  }
}

// Shared across supplier, job, and vehicle PO views - each line item on
// a PO gets ticked off and sent wherever it actually needs to go, not
// just wherever the PO as a whole defaults to (buying materials for a
// job and a tool for the van in the same order needs two destinations).
function renderPoLineItemsReceivable(po, canEdit) {
  const items = po.purchase_order_line_items || [];
  return items.map(li => {
    if (li.received) {
      const destLabel = li.destination_type === 'job' ? 'Job' : li.destination_type === 'vehicle' ? 'Vehicle' : 'Warehouse';
      return `<div style="font-size:13px; display:flex; justify-content:space-between; align-items:center; padding:4px 0;">
        <span>${li.description} — ${li.quantity} × ${money(li.unit_cost)} = ${money(li.quantity * li.unit_cost)}</span>
        <span class="badge accepted" style="font-size:11px;">Received - ${destLabel}</span>
      </div>`;
    }
    const etaLabel = li.backorder_eta ? new Date(li.backorder_eta + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : null;
    return `<div style="font-size:13px; display:flex; justify-content:space-between; align-items:center; padding:4px 0; flex-wrap:wrap; gap:6px;">
      <span>${li.description} — ${li.quantity} × ${money(li.unit_cost)} = ${money(li.quantity * li.unit_cost)}
        ${li.is_backordered ? `<span class="badge draft" style="font-size:11px; margin-left:6px;">Backordered${etaLabel ? ' - ETA ' + etaLabel : ''}</span>` : ''}
      </span>
      ${canEdit ? `
        <span style="display:flex; gap:6px;">
          <button type="button" class="secondary receive-line-item-btn" data-line-id="${li.id}" style="font-size:11px; padding:4px 8px;">Receive</button>
          <button type="button" class="secondary backorder-line-item-btn" data-line-id="${li.id}" style="font-size:11px; padding:4px 8px;">${li.is_backordered ? 'Update backorder' : 'Mark backordered'}</button>
        </span>` : '<span class="subtitle" style="font-size:11px;">Not yet received</span>'}
    </div>`;
  }).join('');
}

// Wires up every ".receive-line-item-btn"/".backorder-line-item-btn"
// found in the container - call this after rendering a PO list that
// used renderPoLineItemsReceivable.
function wireReceiveLineItemButtons(containerEl, allPos, defaultDestinationFor, onComplete) {
  function findLineItem(lineId) {
    for (const po of allPos) {
      const found = (po.purchase_order_line_items || []).find(li => li.id === lineId);
      if (found) return { lineItem: found, parentPo: po };
    }
    return {};
  }
  containerEl.querySelectorAll('.receive-line-item-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const { lineItem, parentPo } = findLineItem(btn.dataset.lineId);
      if (lineItem) openReceiveLineItemPanel(lineItem, parentPo, defaultDestinationFor(parentPo), onComplete);
    });
  });
  containerEl.querySelectorAll('.backorder-line-item-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const { lineItem } = findLineItem(btn.dataset.lineId);
      if (lineItem) openBackorderPanel(lineItem, onComplete);
    });
  });
}

// Marks a not-yet-received line item as backordered with an expected
// date - a separate status from "received", for when a supplier says an
// item's delayed rather than it having actually arrived.
function openBackorderPanel(lineItem, onComplete) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:360px; width:100%;">
      <h2>Backorder</h2>
      <p class="subtitle" style="margin-bottom:10px;">${lineItem.description} x${lineItem.quantity}</p>
      <label style="margin-top:0">Expected date</label>
      <input type="date" id="bo-eta" value="${lineItem.backorder_eta || ''}" />
      <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;">
        <button id="bo-save-btn">Save</button>
        ${lineItem.is_backordered ? '<button type="button" class="secondary" id="bo-clear-btn">No longer backordered</button>' : ''}
        <button type="button" class="secondary" id="bo-cancel-btn">Cancel</button>
      </div>
      <div id="bo-msg"></div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#bo-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#bo-save-btn').addEventListener('click', async () => {
    const msg = overlay.querySelector('#bo-msg');
    const { error } = await supabaseClient.from('purchase_order_line_items')
      .update({ is_backordered: true, backorder_eta: overlay.querySelector('#bo-eta').value || null })
      .eq('id', lineItem.id);
    if (error) { msg.innerHTML = `<div class="error-box">${error.message}</div>`; return; }
    overlay.remove();
    await onComplete();
  });
  const clearBtn = overlay.querySelector('#bo-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const msg = overlay.querySelector('#bo-msg');
      const { error } = await supabaseClient.from('purchase_order_line_items')
        .update({ is_backordered: false, backorder_eta: null })
        .eq('id', lineItem.id);
      if (error) { msg.innerHTML = `<div class="error-box">${error.message}</div>`; return; }
      overlay.remove();
      await onComplete();
    });
  }
}

async function openReceiveLineItemPanel(lineItem, po, defaultDestination, onComplete) {
  const sourceIsWarehouse = !!po.vehicle_id && !po.supplier_id; // pulled from the shed, not a new purchase
  const { data: vehicles } = await supabaseClient.from('fleet_vehicles').select('id, vehicle_name, rego').eq('holds_stock', true).order('vehicle_name');

  let defaultJobName = null;
  if (po.project_id) {
    const { data: proj } = await supabaseClient.from('projects').select('name, job_number').eq('id', po.project_id).maybeSingle();
    defaultJobName = proj ? (proj.job_number ? `J${proj.job_number}` : proj.name) : null;
  }

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:420px; width:100%; max-height:85vh; overflow-y:auto;">
      <h2>Receive item</h2>
      <p class="subtitle" style="margin-bottom:10px;">${lineItem.description} x${lineItem.quantity}</p>
      <label style="margin-top:0">Send to</label>
      <select id="rl-dest-type">
        <option value="warehouse" ${defaultDestination === 'warehouse' ? 'selected' : ''}>Warehouse</option>
        <option value="job" ${defaultDestination === 'job' ? 'selected' : ''}>A job</option>
        ${vehicles?.length ? `<option value="vehicle" ${defaultDestination === 'vehicle' ? 'selected' : ''}>A vehicle</option>` : ''}
      </select>
      <div id="rl-job-section" style="display:none; margin-top:8px;">
        <input id="rl-job-search" placeholder="Search for the job..." autocomplete="off" />
        <div id="rl-job-results"></div>
        <div id="rl-job-selected" class="subtitle" style="margin-top:4px;"></div>
      </div>
      <div id="rl-vehicle-section" style="display:none; margin-top:8px;">
        <select id="rl-vehicle-select">${(vehicles || []).map(v => `<option value="${v.id}" ${v.id === po.vehicle_id ? 'selected' : ''}>${v.vehicle_name || v.rego}</option>`).join('')}</select>
      </div>
      <div style="margin-top:14px;">
        <button id="rl-confirm-btn">Confirm received</button>
        <button type="button" class="secondary" id="rl-cancel-btn">Cancel</button>
      </div>
      <div id="rl-msg"></div>
    </div>`;
  document.body.appendChild(overlay);

  function syncSections() {
    const val = overlay.querySelector('#rl-dest-type').value;
    overlay.querySelector('#rl-job-section').style.display = val === 'job' ? 'block' : 'none';
    overlay.querySelector('#rl-vehicle-section').style.display = val === 'vehicle' ? 'block' : 'none';
  }
  overlay.querySelector('#rl-dest-type').addEventListener('change', syncSections);
  syncSections();

  let selectedJob = po.project_id ? { id: po.project_id, name: defaultJobName } : null;
  const jobSearchInput = overlay.querySelector('#rl-job-search');
  if (po.project_id) {
    overlay.querySelector('#rl-job-selected').textContent = defaultJobName ? `This PO's own job: ${defaultJobName}` : 'This PO\'s own job (default)';
  }
  let jobSearchTimeout;
  jobSearchInput.addEventListener('input', (e) => {
    clearTimeout(jobSearchTimeout);
    selectedJob = null;
    const q = e.target.value.trim();
    if (q.length < 2) { overlay.querySelector('#rl-job-results').innerHTML = ''; return; }
    jobSearchTimeout = setTimeout(async () => {
      const results = await searchProjects(q);
      const resultsEl = overlay.querySelector('#rl-job-results');
      resultsEl.innerHTML = `<div style="border:1px solid var(--border); border-radius:8px; margin-top:6px;">
        ${results.map(p => `<div class="rl-job-pick" data-id="${p.id}" data-name="${p.name}" data-job-number="${p.job_number || ''}" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--border);">${projectRef(p)}</div>`).join('')}
      </div>`;
      resultsEl.querySelectorAll('.rl-job-pick').forEach(row => {
        row.addEventListener('click', () => {
          selectedJob = { id: row.dataset.id, name: row.dataset.jobNumber ? `J${row.dataset.jobNumber}` : row.dataset.name };
          jobSearchInput.value = row.dataset.name;
          overlay.querySelector('#rl-job-selected').textContent = `Selected: ${row.dataset.name}`;
          resultsEl.innerHTML = '';
        });
      });
    }, 250);
  });

  overlay.querySelector('#rl-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#rl-confirm-btn').addEventListener('click', async () => {
    const msg = overlay.querySelector('#rl-msg');
    const destType = overlay.querySelector('#rl-dest-type').value;
    if (destType === 'job' && !selectedJob) { msg.innerHTML = `<div class="error-box">Search for and select a job.</div>`; return; }
    const vehicleId = destType === 'vehicle' ? overlay.querySelector('#rl-vehicle-select').value : null;

    try {
      const { data: { user } } = await supabaseClient.auth.getUser();

      if (destType === 'warehouse') {
        // If this PO itself was a vehicle-pull-from-stock (no supplier),
        // the warehouse quantity was already the source, not the
        // destination - this path only ever ADDS to warehouse.
        const { data: whRow } = await supabaseClient.from('material_stock_by_location').select('*').eq('material_id', lineItem.material_id).eq('location_type', 'warehouse').maybeSingle();
        if (whRow) {
          await supabaseClient.from('material_stock_by_location').update({ quantity: Number(whRow.quantity) + Number(lineItem.quantity), updated_at: new Date().toISOString() }).eq('id', whRow.id);
        } else {
          await supabaseClient.from('material_stock_by_location').insert({ material_id: lineItem.material_id, location_type: 'warehouse', quantity: lineItem.quantity });
        }
      } else if (destType === 'job') {
        await supabaseClient.from('job_material_usage').insert({
          project_id: selectedJob.id, cost_centre_id: po.cost_centre_id || null, material_id: lineItem.material_id,
          quantity: lineItem.quantity, unit_cost: lineItem.unit_cost, source: 'from_po', po_line_item_id: lineItem.id, created_by: user.id,
        });
      } else if (destType === 'vehicle') {
        if (sourceIsWarehouse) {
          const { data: whRow } = await supabaseClient.from('material_stock_by_location').select('*').eq('material_id', lineItem.material_id).eq('location_type', 'warehouse').maybeSingle();
          const warehouseQty = Number(whRow?.quantity) || 0;
          if (lineItem.quantity > warehouseQty) throw new Error(`Only ${warehouseQty} available in the Warehouse.`);
          if (whRow) {
            await supabaseClient.from('material_stock_by_location').update({ quantity: warehouseQty - lineItem.quantity, updated_at: new Date().toISOString() }).eq('id', whRow.id);
          }
        }
        const { data: vehRow } = await supabaseClient.from('material_stock_by_location').select('*').eq('material_id', lineItem.material_id).eq('location_type', 'vehicle').eq('vehicle_id', vehicleId).maybeSingle();
        if (vehRow) {
          await supabaseClient.from('material_stock_by_location').update({ quantity: Number(vehRow.quantity) + Number(lineItem.quantity), updated_at: new Date().toISOString() }).eq('id', vehRow.id);
        } else {
          await supabaseClient.from('material_stock_by_location').insert({ material_id: lineItem.material_id, location_type: 'vehicle', vehicle_id: vehicleId, quantity: lineItem.quantity });
        }
      }

      await supabaseClient.from('purchase_order_line_items').update({
        received: true, destination_type: destType,
        destination_job_id: destType === 'job' ? selectedJob.id : null,
        destination_vehicle_id: destType === 'vehicle' ? vehicleId : null,
        received_by: user.id, received_at: new Date().toISOString(),
      }).eq('id', lineItem.id);

      const destLabel = destType === 'job' ? (selectedJob.name || 'a job') : destType === 'vehicle' ? (vehicles.find(v => v.id === vehicleId)?.vehicle_name || vehicles.find(v => v.id === vehicleId)?.rego || 'a vehicle') : 'Warehouse';
      await logActivity('purchase_order', po.id, 'item_received', `${lineItem.description} x${lineItem.quantity} received - sent to ${destLabel}`);
      if (destType === 'job') {
        await logActivity('project', selectedJob.id, 'material_received', `${lineItem.description} x${lineItem.quantity} received from PO ${po.po_number || ''}, costed to this job`);
      }

      // If every line item on this PO is now received, mark the PO
      // itself received and approve any linked bill for payment.
      const { data: allItems } = await supabaseClient.from('purchase_order_line_items').select('received').eq('po_id', po.id);
      if ((allItems || []).every(li => li.received)) {
        await supabaseClient.from('purchase_orders').update({
          received: true, received_by: user.id, received_at: new Date().toISOString(),
        }).eq('id', po.id);
        await supabaseClient.from('supplier_bills').update({ approved_for_payment: true }).eq('po_id', po.id);
        await logActivity('purchase_order', po.id, 'fully_received', `PO ${po.po_number || ''} fully received - any linked bill approved for payment`);
      }

      overlay.remove();
      if (onComplete) await onComplete();
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${err.message}</div>`;
    }
  });
}

// Draws the next sequential PO number (e.g. "PO2001") - same atomic
// counter pattern already used for quotes/jobs/invoices, so two people
// creating a PO at the same moment never collide.
async function drawNextPoNumber() {
  const { data: settings } = await supabaseClient.from('company_settings').select('po_number_prefix').eq('id', 1).single();
  const prefix = settings?.po_number_prefix || 'PO';
  const { data: nextNum, error } = await supabaseClient.rpc('get_next_number', { counter_name: 'po' });
  if (error) throw error;
  return `${prefix}${nextNum}`;
}

// Upload a photo/file of a supplier invoice straight against a specific
// PO - lets staff scan it while still standing at the wholesaler, rather
// than typing every line item by hand later. The supplier is already
// known from the PO, so this skips straight to the review screen on
// that supplier's page instead of asking which supplier it's for.
function uploadInvoiceForPo(po) {
  if (!po.supplier_id) {
    alert("This PO has no supplier attached - it was pulled from Warehouse stock, so there's no invoice to upload.");
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,.jpg,.jpeg,.png';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px;';
    overlay.innerHTML = `<div class="card" style="max-width:400px; width:100%;"><p class="subtitle">Reading the invoice...</p></div>`;
    document.body.appendChild(overlay);

    try {
      const fileBase64 = await fileToBase64(file);
      const { data: { session } } = await supabaseClient.auth.getSession();
      const res = await fetch('/.netlify/functions/extract-supplier-invoice', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ fileBase64, mediaType: file.type }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Extraction failed');

      sessionStorage.setItem('pending_upload', JSON.stringify({
        type: 'bill', extracted: data.extracted, fileBase64, fileName: file.name, fileType: file.type, preselectedPoId: po.id,
      }));
      window.location.href = `/supplier-detail.html?id=${po.supplier_id}&resume_upload=1`;
    } catch (err) {
      overlay.querySelector('.card').innerHTML = `<h2>Couldn't read that invoice</h2><div class="error-box">${err.message}</div><button type="button" class="secondary" id="uip-close">Close</button>`;
      overlay.querySelector('#uip-close').addEventListener('click', () => overlay.remove());
    }
  };
  input.click();
}

// Shared searchable material picker for PO line items - replaces a plain
// dropdown (unworkable with a large materials list) with type-ahead
// search, while still allowing a free-text item that isn't in Stock at
// all yet (e.g. a one-off "10A power point") rather than forcing a full
// Stock record to be created just to order something.
function buildMaterialSearchRow(materials, containerId) {
  const row = document.createElement('div');
  row.className = 'po-material-line';
  row.style.cssText = 'display:grid; grid-template-columns:2fr 1fr 1fr auto; gap:6px; margin-bottom:6px; position:relative;';
  row.innerHTML = `
    <div style="position:relative;">
      <input class="po-line-search" placeholder="Search Stock or type a new item..." autocomplete="off" style="font-size:13px;" />
      <input type="hidden" class="po-line-material-id" />
      <div class="po-line-results" style="position:absolute; top:100%; left:0; right:0; z-index:10; background:var(--surface-2); border:1px solid var(--border); border-radius:8px; display:none;"></div>
    </div>
    <input class="po-line-qty" type="number" step="1" value="1" placeholder="Qty" style="font-size:13px;" />
    <input class="po-line-cost" type="number" step="0.01" value="0" placeholder="Unit cost" style="font-size:13px;" />
    <button type="button" class="secondary po-remove-line" style="padding:6px 10px; font-size:12px;">&times;</button>`;
  document.getElementById(containerId).appendChild(row);

  const searchInput = row.querySelector('.po-line-search');
  const resultsEl = row.querySelector('.po-line-results');
  const materialIdInput = row.querySelector('.po-line-material-id');

  searchInput.addEventListener('input', (e) => {
    materialIdInput.value = ''; // typing again means whatever was selected no longer applies
    const q = e.target.value.trim().toLowerCase();
    if (q.length < 2) { resultsEl.style.display = 'none'; return; }
    const matches = materials.filter(m => m.name.toLowerCase().includes(q)).slice(0, 8);
    if (!matches.length) { resultsEl.style.display = 'none'; return; }
    resultsEl.innerHTML = matches.map(m => `<div class="po-line-pick" data-id="${m.id}" data-name="${m.name}" data-cost="${m.cost_price}" style="padding:8px 10px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border);">${m.name} <span class="subtitle">(${money(m.cost_price)})</span></div>`).join('');
    resultsEl.style.display = 'block';
    resultsEl.querySelectorAll('.po-line-pick').forEach(pick => {
      pick.addEventListener('click', () => {
        searchInput.value = pick.dataset.name;
        materialIdInput.value = pick.dataset.id;
        row.querySelector('.po-line-cost').value = pick.dataset.cost;
        resultsEl.style.display = 'none';
      });
    });
  });
  searchInput.addEventListener('blur', () => setTimeout(() => { resultsEl.style.display = 'none'; }, 200));

  row.querySelector('.po-remove-line').addEventListener('click', () => row.remove());
  return row;
}

// Reads every .po-material-line row inside a container into plain line
// item objects - materialId is null for a free-text item not in Stock.
function readMaterialLineRows(containerId) {
  return [...document.querySelectorAll(`#${containerId} .po-material-line`)].map(row => ({
    materialId: row.querySelector('.po-line-material-id').value || null,
    description: row.querySelector('.po-line-search').value.trim(),
    quantity: parseFloat(row.querySelector('.po-line-qty').value) || 0,
    unit_cost: parseFloat(row.querySelector('.po-line-cost').value) || 0,
  })).filter(l => l.description && l.quantity > 0);
}

// Universal activity log - one shared table for every entity type. Call
// logActivity() from anywhere something gets created, changed, or
// approved; call renderActivityLog() to show a "Log" section on any
// detail page, filtered to that one record.
async function logActivity(entityType, entityId, action, description) {
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    await supabaseClient.from('activity_log').insert({
      entity_type: entityType, entity_id: entityId, action, description, changed_by: user?.id || null,
    });
  } catch (err) {
    console.error('Activity log write failed:', err); // never block the real action over a logging failure
  }
}

// Every job-linked purchase order gets a matching follow-up task
// automatically, so a delivery doesn't quietly fall through the cracks -
// left unassigned, so whoever's watching the job can pick it up. Only
// called where a PO is being newly ordered against a real job (never for
// a stock/vehicle PO with no project, or one created after the fact from
// an already-reconciled supplier bill - there's nothing to "follow up"
// on there).
async function createPoFollowUpTask(projectId, poNumber, supplierName) {
  if (!projectId) return;
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    await supabaseClient.from('job_tasks').insert({
      project_id: projectId,
      description: `Follow up PO${poNumber ? ' ' + poNumber : ''} with ${supplierName || 'the supplier'}`,
      created_by: user?.id || null,
    });
  } catch (err) {
    console.error('PO follow-up task creation failed:', err); // never block the PO creation over this
  }
}

async function renderActivityLog(entityType, entityId, containerId) {
  const containerEl = document.getElementById(containerId);
  if (!containerEl) return;
  containerEl.innerHTML = `<p class="subtitle">Loading...</p>`;

  const { data: entries, error } = await supabaseClient
    .from('activity_log')
    .select('*, profiles(full_name)')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false });

  if (error) { containerEl.innerHTML = `<div class="error-box">${error.message}</div>`; return; }
  if (!entries.length) { containerEl.innerHTML = `<p class="subtitle">No activity logged yet.</p>`; return; }

  containerEl.innerHTML = entries.map(e => `
    <div style="display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--border); font-size:13px;">
      <span>${e.description}</span>
      <span class="subtitle" style="white-space:nowrap;">${e.profiles?.full_name || 'Someone'} - ${new Date(e.created_at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
    </div>`).join('');
}

// Shared safety check before deleting a quote/job - blocks (rather than
// just warns) if real activity already exists against it, since an
// invoice, PO, or logged time represents something that actually
// happened and shouldn't just disappear via a bulk delete.
async function checkProjectHasActivity(project) {
  const reasons = [];
  const invoiced = (project.cost_centres || []).reduce((s, c) => s + (Number(c.invoiced_amount) || 0), 0);
  if (invoiced > 0) reasons.push(`has ${money(invoiced)} invoiced`);

  const { count: poCount } = await supabaseClient.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('project_id', project.id);
  if (poCount > 0) reasons.push(`has ${poCount} purchase order${poCount === 1 ? '' : 's'}`);

  const { count: timeCount } = await supabaseClient.from('time_entries').select('id', { count: 'exact', head: true }).eq('project_id', project.id);
  if (timeCount > 0) reasons.push(`has ${timeCount} logged time ${timeCount === 1 ? 'entry' : 'entries'}`);

  return reasons;
}

// Same idea as checkProjectHasActivity, but scoped to one stage - used
// when a job's edit removes a stage that used to exist, so only the
// specific stage being removed gets blocked, not the whole save.
async function checkCostCentreHasActivity(costCentre) {
  const reasons = [];
  const invoiced = Number(costCentre.invoiced_amount) || 0;
  if (invoiced > 0) reasons.push(`has ${money(invoiced)} invoiced`);

  const { count: poCount } = await supabaseClient.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('cost_centre_id', costCentre.id);
  if (poCount > 0) reasons.push(`has ${poCount} purchase order${poCount === 1 ? '' : 's'}`);

  const [{ count: directTimeCount }, { count: splitTimeCount }] = await Promise.all([
    supabaseClient.from('time_entries').select('id', { count: 'exact', head: true }).eq('cost_centre_id', costCentre.id),
    supabaseClient.from('time_entries').select('id', { count: 'exact', head: true }).contains('selected_cost_centre_ids', [costCentre.id]),
  ]);
  const timeCount = (directTimeCount || 0) + (splitTimeCount || 0);
  if (timeCount > 0) reasons.push(`has ${timeCount} logged time ${timeCount === 1 ? 'entry' : 'entries'}`);

  return reasons;
}

// Deletes a project after the caller has already run the activity
// check (or, in dev mode, deliberately chosen to delete it anyway).
// Cascade behavior on several of these foreign keys isn't something I
// can verify locally (some of these tables predate the migration files
// I have visibility into), so this explicitly cleans up every
// dependent record in the correct order rather than assuming the
// database will do it - invoices/purchase orders first (since old-style
// invoices can reference a cost_centre directly), then the cost
// centres themselves, then the project.
async function deleteProject(projectId) {
  const { data: centres } = await supabaseClient.from('cost_centres').select('id').eq('project_id', projectId);
  const centreIds = (centres || []).map(c => c.id);

  const { data: invoices } = await supabaseClient.from('invoices').select('id').eq('project_id', projectId);
  const invoiceIds = (invoices || []).map(i => i.id);
  if (invoiceIds.length) {
    await supabaseClient.from('invoice_claims').delete().in('invoice_id', invoiceIds);
    await supabaseClient.from('invoices').delete().in('id', invoiceIds);
  }

  const { data: pos } = await supabaseClient.from('purchase_orders').select('id').eq('project_id', projectId);
  const poIds = (pos || []).map(po => po.id);
  if (poIds.length) {
    await supabaseClient.from('purchase_order_line_items').delete().in('purchase_order_id', poIds);
    await supabaseClient.from('purchase_orders').delete().in('id', poIds);
  }

  if (centreIds.length) {
    await supabaseClient.from('cost_centre_line_items').delete().in('cost_centre_id', centreIds);
    await supabaseClient.from('cost_centre_photo_groups').delete().in('cost_centre_id', centreIds);
    await supabaseClient.from('cost_centres').delete().in('id', centreIds);
  }

  const { error } = await supabaseClient.from('projects').delete().eq('id', projectId);
  if (error) throw error;
}

// The two correct ways to change a material's Warehouse stock - used
// everywhere Warehouse quantity changes, so material_stock_by_location
// (and the trigger-maintained materials.quantity_on_hand total) never
// drifts out of sync the way direct writes to quantity_on_hand did.

// Adds (or subtracts, if negative) a quantity - for bills arriving,
// materials being drawn for a job, etc. Never goes below zero.
async function adjustWarehouseStock(materialId, quantityDelta) {
  const { data: whRow } = await supabaseClient.from('material_stock_by_location').select('*').eq('material_id', materialId).eq('location_type', 'warehouse').maybeSingle();
  if (whRow) {
    await supabaseClient.from('material_stock_by_location').update({
      quantity: Math.max(0, Number(whRow.quantity) + quantityDelta), updated_at: new Date().toISOString(),
    }).eq('id', whRow.id);
  } else {
    await supabaseClient.from('material_stock_by_location').insert({
      material_id: materialId, location_type: 'warehouse', quantity: Math.max(0, quantityDelta),
    });
  }
}

// Sets Warehouse quantity to an exact value - for manual admin edits
// where the person is stating "we have X of these", not adding to
// whatever's already recorded.
async function setWarehouseStock(materialId, absoluteQuantity) {
  const { data: whRow } = await supabaseClient.from('material_stock_by_location').select('id').eq('material_id', materialId).eq('location_type', 'warehouse').maybeSingle();
  if (whRow) {
    await supabaseClient.from('material_stock_by_location').update({
      quantity: Math.max(0, absoluteQuantity), updated_at: new Date().toISOString(),
    }).eq('id', whRow.id);
  } else {
    await supabaseClient.from('material_stock_by_location').insert({
      material_id: materialId, location_type: 'warehouse', quantity: Math.max(0, absoluteQuantity),
    });
  }
}

// Consistent number-first formatting for jobs and quotes, used
// everywhere a project gets referenced - a job number always wins once
// one exists (an approved job), falling back to the quote number
// before it's approved, matching the same numbering-over-naming
// convention already used for POs (PO2000) and invoices (SI3000).
function projectRef(project) {
  if (!project) return '';
  if (project.job_number) return `J${project.job_number} - ${project.name}`;
  if (project.quote_number) return `Q${project.quote_number} - ${project.name}`;
  return project.name || '';
}

// Just the number+prefix on its own, no name - for compact contexts
// like table columns where the name already has its own column.
function projectNumberOnly(project) {
  if (!project) return '-';
  if (project.job_number) return `J${project.job_number}`;
  if (project.quote_number) return `Q${project.quote_number}`;
  return '-';
}

// Resolves one invoice row into a flat list of per-stage claims - mirrors
// invoice_claims when present (a multi-stage claim), else synthesizes one
// claim from the invoice's own totals for a legacy single-stage invoice
// (cost_centre_id set directly, no invoice_claims rows). Needs the invoice
// fetched with both invoice_claims(*, cost_centres(name, sort_order)) and
// cost_centres(name) embedded - nothing else is looked up externally, so
// this works the same wherever an invoice is fetched from.
function invoiceClaimRows(invoice) {
  if (invoice.invoice_claims && invoice.invoice_claims.length) {
    return invoice.invoice_claims.slice()
      .sort((a, b) => (a.cost_centres?.sort_order || 0) - (b.cost_centres?.sort_order || 0))
      .map(ic => ({ stageName: ic.cost_centres?.name || 'Stage', labour_amount: ic.labour_amount, material_amount: ic.material_amount, stc_amount: ic.stc_amount }));
  }
  return [{
    stageName: invoice.cost_centres?.name || invoice.description || 'Invoice',
    labour_amount: invoice.labour_amount, material_amount: invoice.material_amount, stc_amount: invoice.stc_amount,
  }];
}

// Groups an invoice's claims by Xero category (Labour/Materials/STC
// credit) instead of by stage - this is how Xero actually receives it
// (push-invoice-to-xero.js sends one line per stage per category), and
// how it should read for anyone checking the coding before pushing.
// clientType picks the right STC mapping (a company vs an individual
// gets credited to a different account). Drops any category with
// nothing in it.
function xeroCategoryGroups(invoice, mappings, clientType) {
  const rows = invoiceClaimRows(invoice);
  const labourMap = (mappings || []).find(m => m.category === 'labour');
  const materialsMap = (mappings || []).find(m => m.category === 'materials');
  const stcMap = (mappings || []).find(m => m.category === (clientType === 'company' ? 'stc_credits_company' : 'stc_credits_individual'));
  return [
    { label: 'Labour', map: labourMap, lines: rows.map(r => ({ stageName: r.stageName, amount: Number(r.labour_amount) || 0 })).filter(l => l.amount > 0) },
    { label: 'Materials', map: materialsMap, lines: rows.map(r => ({ stageName: r.stageName, amount: Number(r.material_amount) || 0 })).filter(l => l.amount > 0) },
    { label: 'STC Credit', map: stcMap, lines: rows.map(r => ({ stageName: r.stageName, amount: -(Number(r.stc_amount) || 0) })).filter(l => l.amount !== 0) },
  ].filter(g => g.lines.length);
}

// Renders the category-grouped breakdown above as HTML - a per-stage line
// only shows when a category spans more than one stage, since most
// invoices are single-stage and a stage-vs-total line repeating the same
// number twice is just noise.
function xeroBreakdownHtml(invoice, mappings, clientType) {
  const groups = xeroCategoryGroups(invoice, mappings, clientType);
  if (!groups.length) return `<p class="subtitle">Nothing to post.</p>`;
  return groups.map(g => {
    const total = g.lines.reduce((s, l) => s + l.amount, 0);
    return `
      <div style="margin-bottom:10px;">
        <div style="display:flex; justify-content:space-between; gap:10px; font-weight:600;">
          <span>${g.label}</span>
          <span style="text-align:right; font-weight:400;">${g.map ? `${g.map.xero_account_code} (${g.map.xero_tax_type})` : '<span style="color:var(--red);">Not mapped - set this in Settings &gt; Xero Mapping</span>'}</span>
        </div>
        ${g.lines.length > 1 ? g.lines.map(l => `<div style="display:flex; justify-content:space-between; font-size:12px; color:var(--muted); padding-left:12px;"><span>${l.stageName}</span><span>${money(l.amount)}</span></div>`).join('') : ''}
        <div style="display:flex; justify-content:space-between; font-size:13px; ${g.lines.length > 1 ? 'border-top:1px solid var(--border); margin-top:2px; padding-top:2px;' : ''}"><span>${g.lines.length === 1 ? g.lines[0].stageName : 'Subtotal'}</span><span>${money(total)}</span></div>
      </div>`;
  }).join('');
}
