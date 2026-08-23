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
const COST_CENTRE_COLS_PRICING = 'markup_percent, quoted_amount, labour_cost, material_cost, invoiced_amount, stc_total';
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

// Single source of truth for the main nav - every page calls
// renderMainNav('key') into empty <nav id="topbar-tabs"> and
// <div id="mobile-menu-dropdown"> containers, instead of each page
// hand-maintaining its own copy of the same 13 links (which is exactly
// how small nav inconsistencies kept creeping in before this existed).
const MAIN_NAV_ITEMS = [
  { key: 'leads', label: 'Leads', href: '/leads.html' },
  { key: 'quotes', label: 'Quotes', href: '/quotes.html' },
  { key: 'projects', label: 'Projects', href: '/projects.html' },
  { key: 'job-pipeline', label: 'Job pipeline', href: '/dashboard.html' },
  { key: 'purchase-orders', label: 'Purchase Orders', href: '/purchase-orders.html' },
  { key: 'invoices', label: 'Invoices', href: '/invoices.html' },
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
  return jobNumber ? `${jobNumber}-${position}` : `-${position}`;
}
