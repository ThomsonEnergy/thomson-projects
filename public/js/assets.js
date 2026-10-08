// Customer assets (customer_assets / asset_reminder_log): what we've installed
// for whom, with warranty and servicing dates. Shared by the Assets page and
// the Assets card on a job. Needs supabase-client.js loaded first.

const ASSET_TYPES = [
  { key: 'solar', label: 'Solar system', serviceWord: 'panel clean and system check', defaultInterval: 12 },
  { key: 'battery', label: 'Battery', serviceWord: 'battery health check', defaultInterval: null },
  { key: 'inverter', label: 'Inverter', serviceWord: 'inverter check', defaultInterval: null },
  { key: 'generator', label: 'Generator', serviceWord: 'service', defaultInterval: 12 },
  { key: 'ev_charger', label: 'EV charger', serviceWord: 'charger check', defaultInterval: null },
  { key: 'switchboard', label: 'Switchboard', serviceWord: 'safety inspection', defaultInterval: null },
  { key: 'air_con', label: 'Air conditioner', serviceWord: 'service', defaultInterval: 12 },
  { key: 'other', label: 'Other', serviceWord: 'service', defaultInterval: null },
];
const assetTypeInfo = (key) => ASSET_TYPES.find(t => t.key === key) || ASSET_TYPES[ASSET_TYPES.length - 1];

// ---------- dates ----------
function assetIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function assetToday() { return assetIsoDate(new Date()); }
function assetAddMonths(iso, months) {
  const d = new Date(iso + 'T00:00:00');
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() !== day) d.setDate(0); // 31 Jan + 1 month -> end of Feb, not early March
  return assetIsoDate(d);
}
function assetAddYears(iso, years) { return assetAddMonths(iso, Math.round(years * 12)); }
function assetDaysUntil(iso) {
  return Math.round((new Date(iso + 'T00:00:00') - new Date(assetToday() + 'T00:00:00')) / 86400000);
}
function assetFmtDate(iso) {
  return iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
}

// Coloured status text for a service/warranty date.
function assetDateBadge(iso, kind) {
  if (!iso) return '<span class="subtitle">-</span>';
  const days = assetDaysUntil(iso);
  const label = assetFmtDate(iso);
  if (days < 0) return `<span style="color:var(--red); font-weight:600;">${kind === 'warranty' ? 'Expired' : 'Overdue'} ${label}</span>`;
  const soon = kind === 'warranty' ? 90 : 30;
  if (days <= soon) return `<span style="color:var(--red); font-weight:600;">${label} (${days}d)</span>`;
  return label;
}

// ---------- email ----------
function assetFirstName(name) { return (String(name || '').trim().split(/\s+/)[0]) || 'there'; }
function assetMerge(text, ctx) {
  return String(text).replace(/\{(\w+)\}/g, (m, key) => (ctx[key] !== undefined ? ctx[key] : m));
}
function assetEmailDefaults(kind, asset, clientName) {
  const t = assetTypeInfo(asset.asset_type);
  const first = assetFirstName(clientName || asset.client_name);
  const where = asset.site_address ? ` at ${asset.site_address}` : '';
  const what = [asset.make, asset.model].filter(Boolean).join(' ');
  if (kind === 'warranty') {
    return {
      subject: `Your ${asset.name} warranty ends on ${assetFmtDate(asset.warranty_expires)}`,
      body: `Hi ${first},\n\nJust a heads up that the warranty on your ${asset.name}${what ? ` (${what})` : ''}${where} ends on ${assetFmtDate(asset.warranty_expires)}.${asset.warranty_notes ? `\n\nWarranty notes: ${asset.warranty_notes}` : ''}\n\nIf you've noticed any issues, now is the time to let us know so we can look into it while it's still covered. We're also happy to do a ${t.serviceWord} before the warranty ends - just reply to this email or give us a call and we'll find a time that suits you.\n\nThanks,`,
    };
  }
  const days = asset.next_service_due ? assetDaysUntil(asset.next_service_due) : 0;
  const duePhrase = asset.next_service_due ? (days < 0 ? `(it was due on ${assetFmtDate(asset.next_service_due)})` : `(due around ${assetFmtDate(asset.next_service_due)})`) : '';
  return {
    subject: `Time for a ${t.serviceWord} - your ${asset.name}`,
    body: `Hi ${first},\n\nIt's been a little while since we installed your ${asset.name}${where}, and it's due for a ${t.serviceWord} ${duePhrase}.\n\nRegular servicing keeps it performing at its best and helps protect your warranty. Just reply to this email or give us a call and we'll find a time that suits you.\n\nThanks,`.replace(/ \./g, '.'),
  };
}
async function sendCustomerEmail({ to, subject, bodyText }) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const res = await fetch('/.netlify/functions/send-gmail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ to, subject, bodyText }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || 'Could not send the email');
  return data;
}
async function logAssetEmail({ asset, clientId, kind, outcome = 'sent', campaignName = null, subject = null, sentTo = null }) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  await supabaseClient.from('asset_reminder_log').insert({
    asset_id: asset.id, client_id: clientId || asset.client_id || null, kind, outcome,
    campaign_name: campaignName, subject, sent_to: sentTo, sent_by: user.id,
  });
}

// Marks an asset serviced on `dateIso` and works out the next due date.
async function recordAssetService(asset, dateIso, note) {
  const update = { last_serviced_at: dateIso };
  if (asset.service_interval_months) update.next_service_due = assetAddMonths(dateIso, asset.service_interval_months);
  if (note) update.notes = [asset.notes, `Serviced ${assetFmtDate(dateIso)}: ${note}`].filter(Boolean).join('\n');
  const { error } = await supabaseClient.from('customer_assets').update(update).eq('id', asset.id);
  if (error) throw error;
}

// ---------- add / edit panel ----------
// opts: { asset (existing, or null), prefill ({...fields} for a new one), onSaved }
async function openAssetPanel(opts = {}) {
  const existing = opts.asset || null;
  const a = { ...(opts.prefill || {}), ...(existing || {}) };
  let clientId = a.client_id || null;
  let clientInfo = null;
  if (clientId) {
    const { data } = await supabaseClient.from('clients').select('id, name, email, address').eq('id', clientId).maybeSingle();
    clientInfo = data;
  }
  let history = [];
  if (existing) {
    const { data } = await supabaseClient.from('asset_reminder_log').select('kind, outcome, subject, sent_to, sent_at, campaign_name').eq('asset_id', existing.id).order('sent_at', { ascending: false }).limit(15);
    history = data || [];
  }

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:150; padding:16px; overflow-y:auto;';
  const v = (k) => escapeHtml(a[k] === null || a[k] === undefined ? '' : a[k]);
  const warrantyYears = (a.installed_at && a.warranty_expires) ? (Math.round(((new Date(a.warranty_expires) - new Date(a.installed_at)) / 86400000 / 365.25) * 10) / 10) : '';
  overlay.innerHTML = `
    <div class="card" style="max-width:640px; width:100%; max-height:92vh; overflow-y:auto;">
      <h2>${existing ? 'Edit' : 'Add'} customer asset</h2>

      <label style="margin-top:0;">Customer</label>
      <div style="position:relative;">
        <input id="as-client-search" placeholder="Search clients by name, email or phone..." autocomplete="off" value="${escapeHtml(clientInfo ? clientInfo.name : (a.client_name || ''))}" />
        <div id="as-client-results" style="display:none; position:absolute; top:100%; left:0; right:0; background:var(--surface); border:1px solid var(--border); border-radius:8px; margin-top:4px; max-height:200px; overflow-y:auto; z-index:10;"></div>
      </div>
      <p class="subtitle" id="as-client-note" style="margin:4px 0 0; font-size:12px;">${clientInfo ? `Linked to ${escapeHtml(clientInfo.name)}${clientInfo.email ? ' - ' + escapeHtml(clientInfo.email) : ' - <strong>no email on file</strong>, so reminders can\'t be sent'}` : 'Pick an existing client so reminders know where to go, or just type a name.'}</p>

      <label>Site address</label>
      <input id="as-address" value="${v('site_address')}" placeholder="Where it's installed" />

      <div class="grid cols-2">
        <div><label>Type</label><select id="as-type">${ASSET_TYPES.map(t => `<option value="${t.key}" ${a.asset_type === t.key ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div>
        <div><label>Quantity</label><input id="as-qty" type="number" min="1" value="${a.quantity || 1}" /></div>
      </div>
      <label>What was installed</label>
      <input id="as-name" value="${v('name')}" placeholder="e.g. 13.1kW solar system, or Fronius Primo 8kW hybrid inverter" />
      <div class="grid cols-2">
        <div><label>Make</label><input id="as-make" value="${v('make')}" /></div>
        <div><label>Model</label><input id="as-model" value="${v('model')}" /></div>
      </div>
      <label>Serial numbers</label>
      <textarea id="as-serials" style="min-height:60px;" placeholder="One per line, or comma separated">${v('serial_numbers')}</textarea>

      <div class="grid cols-3">
        <div><label>Installed on</label><input id="as-installed" type="date" value="${v('installed_at')}" /></div>
        <div><label>Warranty (years)</label><input id="as-warranty-years" type="number" min="0" step="0.5" value="${warrantyYears}" /></div>
        <div><label>Warranty ends</label><input id="as-warranty-ends" type="date" value="${v('warranty_expires')}" /></div>
      </div>
      <label>Warranty notes</label>
      <input id="as-warranty-notes" value="${v('warranty_notes')}" placeholder="e.g. 25 yr panel performance, 10 yr inverter product warranty" />

      <div class="grid cols-3">
        <div><label>Service every</label>
          <select id="as-interval">
            <option value="">No routine service</option>
            ${[6, 12, 24, 36].map(m => `<option value="${m}" ${Number(a.service_interval_months) === m ? 'selected' : ''}>${m} months</option>`).join('')}
          </select></div>
        <div><label>Last serviced</label><input id="as-last-serviced" type="date" value="${v('last_serviced_at')}" /></div>
        <div><label>Next service due</label><input id="as-next-service" type="date" value="${v('next_service_due')}" /></div>
      </div>

      <label>Notes</label>
      <textarea id="as-notes" style="min-height:60px;">${v('notes')}</textarea>
      <div class="grid cols-2">
        <div><label>Status</label><select id="as-status"><option value="active" ${a.status !== 'decommissioned' ? 'selected' : ''}>Active</option><option value="decommissioned" ${a.status === 'decommissioned' ? 'selected' : ''}>Decommissioned</option></select></div>
        <div><label style="display:flex; align-items:center; gap:8px; margin-top:28px; font-weight:400;"><input id="as-paused" type="checkbox" ${a.reminders_paused ? 'checked' : ''} style="width:auto;" /> Don't send reminders for this</label></div>
      </div>

      ${existing ? `
        <div style="margin-top:14px; padding:10px; border:1px solid var(--border); border-radius:8px;">
          <p class="subtitle" style="margin:0 0 6px; font-weight:600;">Log a service</p>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <input id="as-service-date" type="date" value="${assetToday()}" style="width:auto; margin:0;" />
            <input id="as-service-note" placeholder="What was done (optional)" style="flex:1; min-width:160px; margin:0;" />
            <button type="button" class="secondary" id="as-service-btn">Log service</button>
          </div>
        </div>
        ${history.length ? `
          <p class="subtitle" style="margin:14px 0 4px; font-weight:600;">Emails about this asset</p>
          ${history.map(h => `<p class="subtitle" style="margin:0 0 2px; font-size:12px;">${assetFmtDate(h.sent_at.slice(0, 10))} - ${h.outcome === 'skipped' ? 'skipped' : 'sent'} ${h.kind}${h.campaign_name ? ' (' + escapeHtml(h.campaign_name) + ')' : ''}${h.sent_to ? ' to ' + escapeHtml(h.sent_to) : ''}</p>`).join('')}` : ''}` : ''}

      <div id="as-msg"></div>
      <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;">
        <button type="button" id="as-save">${existing ? 'Save changes' : 'Add asset'}</button>
        <button type="button" class="secondary" id="as-cancel">Cancel</button>
        ${existing ? `<button type="button" class="secondary" id="as-delete" style="margin-left:auto;">Delete</button>` : ''}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const $ = (id) => overlay.querySelector('#' + id);
  const msg = (html) => { $('as-msg').innerHTML = html; };

  // client search
  let searchTimer;
  $('as-client-search').addEventListener('input', () => {
    clientId = null; clientInfo = null;
    clearTimeout(searchTimer);
    const q = $('as-client-search').value.trim();
    if (q.length < 2) { $('as-client-results').style.display = 'none'; return; }
    searchTimer = setTimeout(async () => {
      const { data } = await supabaseClient.from('clients').select('id, name, email, phone, address')
        .or(`name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`).limit(8);
      const box = $('as-client-results');
      box.innerHTML = (data || []).map(c => `<div class="as-client-pick" data-id="${c.id}" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--border);">${escapeHtml(c.name)} <span class="subtitle">${escapeHtml(c.email || c.phone || '')}</span></div>`).join('') || `<div style="padding:8px 12px;" class="subtitle">No matching clients - the name you typed will be used.</div>`;
      box.style.display = 'block';
      box.querySelectorAll('.as-client-pick').forEach(row => row.addEventListener('click', () => {
        const c = data.find(x => x.id === row.dataset.id);
        clientId = c.id; clientInfo = c;
        $('as-client-search').value = c.name;
        if (!$('as-address').value.trim() && c.address) $('as-address').value = c.address;
        $('as-client-note').innerHTML = `Linked to ${escapeHtml(c.name)}${c.email ? ' - ' + escapeHtml(c.email) : ' - <strong>no email on file</strong>, so reminders can\'t be sent'}`;
        box.style.display = 'none';
      }));
    }, 250);
  });

  // dates: warranty years <-> end date, service interval -> next due
  const recomputeWarranty = () => {
    const inst = $('as-installed').value, yrs = parseFloat($('as-warranty-years').value);
    if (inst && yrs > 0) $('as-warranty-ends').value = assetAddYears(inst, yrs);
  };
  $('as-installed').addEventListener('change', () => { recomputeWarranty(); recomputeNext(); });
  $('as-warranty-years').addEventListener('input', recomputeWarranty);
  function recomputeNext() {
    const months = parseInt($('as-interval').value, 10);
    const base = $('as-last-serviced').value || $('as-installed').value;
    if (months && base) $('as-next-service').value = assetAddMonths(base, months);
    if (!months) $('as-next-service').value = '';
  }
  $('as-interval').addEventListener('change', recomputeNext);
  $('as-last-serviced').addEventListener('change', recomputeNext);
  $('as-type').addEventListener('change', () => {
    const t = assetTypeInfo($('as-type').value);
    if (!$('as-interval').value && t.defaultInterval && !existing) { $('as-interval').value = String(t.defaultInterval); recomputeNext(); }
  });

  $('as-cancel').addEventListener('click', () => overlay.remove());
  if (existing) {
    $('as-delete').addEventListener('click', async () => {
      if (!confirm('Delete this asset and its email history?')) return;
      const { error } = await supabaseClient.from('customer_assets').delete().eq('id', existing.id);
      if (error) { msg(`<div class="error-box">${error.message}</div>`); return; }
      overlay.remove(); if (opts.onSaved) await opts.onSaved();
    });
    $('as-service-btn').addEventListener('click', async () => {
      const date = $('as-service-date').value;
      if (!date) { msg(`<div class="error-box">Pick the service date.</div>`); return; }
      try {
        await recordAssetService({ ...existing, service_interval_months: parseInt($('as-interval').value, 10) || null, notes: $('as-notes').value.trim() || null }, date, $('as-service-note').value.trim());
        overlay.remove(); if (opts.onSaved) await opts.onSaved();
      } catch (err) { msg(`<div class="error-box">${err.message}</div>`); }
    });
  }
  $('as-save').addEventListener('click', async () => {
    const name = $('as-name').value.trim();
    const typedClient = $('as-client-search').value.trim();
    if (!name) { msg(`<div class="error-box">Say what was installed.</div>`); return; }
    if (!clientId && !typedClient) { msg(`<div class="error-box">Pick or type a customer.</div>`); return; }
    const interval = parseInt($('as-interval').value, 10) || null;
    const payload = {
      client_id: clientId, client_name: clientId ? (clientInfo && clientInfo.name) || typedClient : typedClient,
      project_id: a.project_id || null,
      site_address: $('as-address').value.trim() || null,
      asset_type: $('as-type').value, name,
      make: $('as-make').value.trim() || null, model: $('as-model').value.trim() || null,
      serial_numbers: $('as-serials').value.trim() || null,
      quantity: Math.max(1, parseInt($('as-qty').value, 10) || 1),
      installed_at: $('as-installed').value || null,
      warranty_expires: $('as-warranty-ends').value || null,
      warranty_notes: $('as-warranty-notes').value.trim() || null,
      service_interval_months: interval,
      last_serviced_at: $('as-last-serviced').value || null,
      next_service_due: interval ? ($('as-next-service').value || null) : null,
      notes: $('as-notes').value.trim() || null,
      status: $('as-status').value,
      reminders_paused: $('as-paused').checked,
    };
    const btn = $('as-save'); btn.disabled = true;
    let res;
    if (existing) res = await supabaseClient.from('customer_assets').update(payload).eq('id', existing.id);
    else {
      const { data: { user } } = await supabaseClient.auth.getUser();
      res = await supabaseClient.from('customer_assets').insert({ ...payload, created_by: user.id });
    }
    btn.disabled = false;
    if (res.error) { msg(`<div class="error-box">${res.error.message}</div>`); return; }
    overlay.remove();
    if (opts.onSaved) await opts.onSaved();
  });
}
