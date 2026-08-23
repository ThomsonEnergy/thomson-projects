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
  { key: 'leads', label: 'Leads', href: '/leads.html' },
  { key: 'quotes', label: 'Quotes', href: '/quotes.html' },
  { key: 'projects', label: 'Projects', href: '/projects.html' },
  { key: 'job-pipeline', label: 'Job pipeline', href: '/dashboard.html' },
  { key: 'invoices', label: 'Invoices', href: '/invoices.html' },
  { key: 'purchase-orders', label: 'Purchase Orders', href: '/purchase-orders.html' },
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
        <span>${li.description} x${li.quantity}</span>
        <span class="badge accepted" style="font-size:11px;">Received - ${destLabel}</span>
      </div>`;
    }
    return `<div style="font-size:13px; display:flex; justify-content:space-between; align-items:center; padding:4px 0;">
      <span>${li.description} x${li.quantity} - ${money(li.quantity * li.unit_cost)}</span>
      ${canEdit ? `<button type="button" class="secondary receive-line-item-btn" data-line-id="${li.id}" style="font-size:11px; padding:4px 8px;">Receive</button>` : '<span class="subtitle" style="font-size:11px;">Not yet received</span>'}
    </div>`;
  }).join('');
}

// Wires up every ".receive-line-item-btn" found in the container - call
// this after rendering a PO list that used renderPoLineItemsReceivable.
function wireReceiveLineItemButtons(containerEl, allPos, defaultDestinationFor, onComplete) {
  containerEl.querySelectorAll('.receive-line-item-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lineId = btn.dataset.lineId;
      let lineItem = null, parentPo = null;
      for (const po of allPos) {
        const found = (po.purchase_order_line_items || []).find(li => li.id === lineId);
        if (found) { lineItem = found; parentPo = po; break; }
      }
      if (lineItem) openReceiveLineItemPanel(lineItem, parentPo, defaultDestinationFor(parentPo), onComplete);
    });
  });
}

async function openReceiveLineItemPanel(lineItem, po, defaultDestination, onComplete) {
  const sourceIsWarehouse = !!po.vehicle_id && !po.supplier_id; // pulled from the shed, not a new purchase
  const { data: vehicles } = await supabaseClient.from('fleet_vehicles').select('id, vehicle_name, rego').eq('holds_stock', true).order('vehicle_name');

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
        <select id="rl-vehicle-select">${(vehicles || []).map(v => `<option value="${v.id}">${v.vehicle_name || v.rego}</option>`).join('')}</select>
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

  let selectedJob = po.project_id ? { id: po.project_id } : null;
  const jobSearchInput = overlay.querySelector('#rl-job-search');
  if (po.project_id) {
    overlay.querySelector('#rl-job-selected').textContent = 'This PO\'s own job (default)';
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
        ${results.map(p => `<div class="rl-job-pick" data-id="${p.id}" data-name="${p.name}" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--border);">${p.job_number ? '#' + p.job_number + ' ' : ''}${p.name}</div>`).join('')}
      </div>`;
      resultsEl.querySelectorAll('.rl-job-pick').forEach(row => {
        row.addEventListener('click', () => {
          selectedJob = { id: row.dataset.id, name: row.dataset.name };
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

      // If every line item on this PO is now received, mark the PO
      // itself received and approve any linked bill for payment.
      const { data: allItems } = await supabaseClient.from('purchase_order_line_items').select('received').eq('po_id', po.id);
      if ((allItems || []).every(li => li.received)) {
        await supabaseClient.from('purchase_orders').update({
          received: true, received_by: user.id, received_at: new Date().toISOString(),
        }).eq('id', po.id);
        await supabaseClient.from('supplier_bills').update({ approved_for_payment: true }).eq('po_id', po.id);
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
