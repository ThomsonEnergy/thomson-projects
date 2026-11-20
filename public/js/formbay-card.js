// The Formbay card on a job's STCs tab (item 101). Loaded by project.html when the tab opens.
//   renderFormbayCard(project, { onChange })   draws into #formbay-card; onChange runs after the job changed
// Shows the job's Formbay battery form: its stage, what it is waiting on, who has signed, the NMI,
// serial numbers and how many of its photos and documents are on the job. With no form yet: Create
// Formbay form (makes a draft in Formbay) or Find this job in Formbay (a form started in Formbay's app).
// Reads formbay_forms and customer_assets; everything else goes through the formbay-sync and
// formbay-create-form functions. Writes only a warranty date on Customer equipment.

const FB_STAGE = {
  new: 'Not started', in_progress: 'In progress', installed: 'Installed, ready to submit', submitted: 'Submitted, Formbay is checking it',
  uploaded: 'With the Clean Energy Regulator', approved: 'Approved, ready to sell', rejected: 'Rejected by the Clean Energy Regulator', sold: 'Sold',
};
const FB_STALE_MS = 2 * 60 * 1000;
const fbChecked = new Set();   // jobs already checked against Formbay since this page opened

async function fbCall(fn, body) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const res = await fetch(`/.netlify/functions/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error('No answer from the server. Try again.');
  if (!json.ok) throw Object.assign(new Error(json.error || 'Formbay did not answer. Try again.'), { confirm: !!json.confirm });
  return json;
}
const fbDate = (v) => (/^\d{2}\/\d{2}\/\d{4}$/.test(String(v || '')) ? v : '');
const fbTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', minute: '2-digit' }) : '');

async function renderFormbayCard(project, { onChange } = {}) {
  const el = document.getElementById('formbay-card');
  if (!el) return;
  const { data: forms, error } = await supabaseClient.from('formbay_forms').select('*').eq('project_id', project.id).order('created_at');
  if (error) { el.innerHTML = `<h2 style="margin:0 0 6px;">Formbay</h2><div class="error-box">${escapeHtml(friendlyError(error))}</div>`; return; }
  const changed = async () => { if (onChange) await onChange(); else await renderFormbayCard(project); };

  if (!forms.length) { fbDrawEmpty(el, project, changed); return; }
  const { data: assets } = await supabaseClient.from('customer_assets').select('id, name, model, installed_at, warranty_expires, formbay_form_id')
    .in('formbay_form_id', forms.map(f => f.id));
  el.innerHTML = `<h2 style="margin:0 0 8px;">Formbay</h2>${forms.map(f => fbFormHtml(f, assets || [])).join('')}<div id="fb-msg"></div>`;

  el.querySelectorAll('[data-fb-check]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Checking...';
    try { await fbCall('formbay-sync', { action: 'refresh', projectId: project.id }); await changed(); }
    catch (err) { document.getElementById('fb-msg').innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`; b.disabled = false; b.textContent = 'Check now'; }
  }));
  el.querySelectorAll('[data-fb-warranty]').forEach(b => b.addEventListener('click', async () => {
    const asset = (assets || []).find(a => a.id === b.dataset.fbWarranty);
    const years = Number(el.querySelector(`[data-fb-years="${b.dataset.fbWarranty}"]`).value);
    if (!asset || !(years > 0 && years <= 40)) { document.getElementById('fb-msg').innerHTML = `<div class="error-box">Type the warranty in years, for example 10.</div>`; return; }
    const d = new Date(`${asset.installed_at}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() + Math.round(years));
    const { error: e } = await supabaseClient.from('customer_assets').update({ warranty_expires: d.toISOString().slice(0, 10) }).eq('id', asset.id);
    if (e) { document.getElementById('fb-msg').innerHTML = `<div class="error-box">${escapeHtml(friendlyError(e))}</div>`; return; }
    await renderFormbayCard(project, { onChange });
  }));

  // Opening the tab checks Formbay once when the last check is more than two minutes old.
  const oldest = Math.min(...forms.map(f => (f.synced_at ? new Date(f.synced_at).getTime() : 0)));
  if (!fbChecked.has(project.id) && Date.now() - oldest > FB_STALE_MS) {
    fbChecked.add(project.id);
    try { await fbCall('formbay-sync', { action: 'refresh', projectId: project.id }); await changed(); } catch (err) { /* the card shows the last read */ }
  }
}

function fbFormHtml(row, assets) {
  const f = row.form || {};
  const waiting = (Array.isArray(f.requirements) ? f.requirements : []).map(r => (typeof r === 'string' ? r : r && r.message)).filter(Boolean);
  const signed = [['Installer', f.installer_signee_date], ['Designer', f.designer_signee_date], ['Owner', f.homeowner_signee_date]]
    .map(([who, d]) => `${who} ${fbDate(d) ? `signed ${fbDate(d)}` : 'not signed yet'}`).join(' · ');
  const battery = (f.batteries || [])[0];
  const serials = (f.battery_serials || []).length + (f.serialnumbersname || []).length + (f.inverterserialnumbersname || []).length;
  const facts = [
    f.nmi ? `NMI ${f.nmi}` : '', fbDate(f.idate) ? `Install date ${f.idate}` : '', battery ? battery.model : '',
    Number(f.calbstc) ? `${Number(f.calbstc)} STCs` : '', serials ? `${serials} serial number${serials === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  const docs = (row.docs || []).length;
  const filedMap = row.filed || {};
  const onJob = Object.values(filedMap).filter(v => v && (v.photo || v.document || v.ccew)).length;
  const kept = Object.values(filedMap).filter(v => v && !v.failed).length;
  const filesLine = !docs ? ''
    : kept >= docs ? `${onJob} photos and documents are on the job (Photos, Documents and the CCEW card).`
    : fbDate(f.installer_signee_date) ? `${onJob} of the form's photos and documents are on the job so far. The rest arrive within 15 minutes.`
    : `${docs} photos and documents in Formbay. They come onto the job once the installer has signed.`;
  const needWarranty = assets.filter(a => a.formbay_form_id === row.id && !a.warranty_expires && a.installed_at);
  const stage = FB_STAGE[row.job_status] || row.job_status || 'Not read yet';
  return `
    <div style="margin-bottom:12px;">
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <strong>Battery form ${escapeHtml(row.formbay_job_id)}</strong>
        <span class="badge ${row.job_status === 'sold' || row.job_status === 'approved' ? 'complete' : row.job_status === 'rejected' ? 'amber' : 'info'}">${escapeHtml(stage)}</span>
      </div>
      ${waiting.length ? `<p style="margin:8px 0 2px; font-weight:600;">Waiting on</p><ul style="margin:0 0 6px 18px; padding:0;">${waiting.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
      ${f.status ? `<p class="subtitle" style="margin:6px 0 0;">${escapeHtml(signed)}</p>` : ''}
      ${facts.length ? `<p class="subtitle" style="margin:4px 0 0;">${escapeHtml(facts.join(' · '))}</p>` : ''}
      ${filesLine ? `<p class="subtitle" style="margin:4px 0 0;">${escapeHtml(filesLine)}</p>` : ''}
      ${needWarranty.map(a => `
        <div style="margin-top:8px; padding:8px 10px; background:var(--surface-2); border-radius:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <span>Warranty for ${escapeHtml(a.model || a.name)}, in years</span>
          <input type="number" min="1" max="40" inputmode="numeric" data-fb-years="${escapeHtml(a.id)}" style="width:80px; margin:0;" />
          <button type="button" class="secondary" data-fb-warranty="${escapeHtml(a.id)}" style="padding:6px 12px;">Save</button>
          <span class="subtitle" style="margin:0;">Asked once, then used for every ${escapeHtml(a.model || 'one')}.</span>
        </div>`).join('')}
      ${row.sync_error ? `<div class="error-box" style="margin-top:8px;">Last check did not work: ${escapeHtml(row.sync_error)}</div>` : ''}
      <p class="subtitle" style="margin:8px 0 0;">${row.synced_at ? `Checked ${escapeHtml(fbTime(row.synced_at))}. ` : ''}Checks itself every 15 minutes.
        <button type="button" class="secondary" data-fb-check style="padding:4px 10px; font-size:12px; margin-left:6px;">Check now</button></p>
    </div>`;
}

// ---------- no form yet: create one, or find one started in Formbay ----------

function fbDrawEmpty(el, project, changed) {
  el.innerHTML = `
    <h2 style="margin:0 0 6px;">Formbay</h2>
    <p class="subtitle" style="margin:0 0 10px;">No Formbay form on this job yet.</p>
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <button type="button" id="fb-create-open">Create Formbay form</button>
      <button type="button" id="fb-find-open" class="secondary">Find this job in Formbay</button>
    </div>
    <div id="fb-panel" style="margin-top:12px;"></div>`;
  const panel = el.querySelector('#fb-panel');
  el.querySelector('#fb-find-open').addEventListener('click', () => fbDrawFind(panel, project, changed));
  el.querySelector('#fb-create-open').addEventListener('click', () => fbDrawCreate(panel, project, changed));
}

async function fbDrawFind(panel, project, changed) {
  panel.innerHTML = `<p class="subtitle">Looking in Formbay...</p>`;
  let forms = [];
  let failed = '';
  try { forms = (await fbCall('formbay-sync', { action: 'find', projectId: project.id })).forms; } catch (err) { failed = err.message; }
  const link = async (formId, btn) => {
    btn.disabled = true;
    panel.querySelector('#fb-find-msg').innerHTML = `<p class="subtitle">Reading form ${escapeHtml(formId)}...</p>`;
    try {
      try { await fbCall('formbay-sync', { action: 'link', projectId: project.id, formId }); }
      catch (err) {
        // A form at another address needs a person's yes: linking puts its NMI, serials and photos on this job.
        if (!err.confirm || !confirm(`${err.message} Link it to this job anyway?`)) throw err;
        await fbCall('formbay-sync', { action: 'link', projectId: project.id, formId, confirmed: true });
      }
      await changed();
    } catch (err) { panel.querySelector('#fb-find-msg').innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`; btn.disabled = false; }
  };
  panel.innerHTML = `
    ${failed ? `<div class="error-box">${escapeHtml(failed)}</div>` : ''}
    ${forms.length ? forms.map(f => `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--border);">
        <div><strong>${escapeHtml(f.formId)}</strong> ${f.match ? '<span class="badge complete">Same address</span>' : ''}
          <div class="subtitle" style="margin:2px 0 0;">${escapeHtml([f.address, f.owner, FB_STAGE[f.status] || f.status].filter(Boolean).join(' · '))}</div></div>
        <button type="button" data-fb-link="${escapeHtml(f.formId)}" class="${f.match ? '' : 'secondary'}" style="white-space:nowrap;">This is it</button>
      </div>`).join('') : (failed ? '' : `<p class="subtitle">Formbay has no battery forms that are not already on a job.</p>`)}
    <div style="display:flex; gap:8px; align-items:center; margin-top:10px; flex-wrap:wrap;">
      <input id="fb-find-id" inputmode="numeric" placeholder="Or type the Formbay job number" style="max-width:240px; margin:0;" />
      <button type="button" id="fb-find-link" class="secondary">Link</button>
    </div>
    <div id="fb-find-msg" style="margin-top:8px;"></div>`;
  panel.querySelectorAll('[data-fb-link]').forEach(b => b.addEventListener('click', () => link(b.dataset.fbLink, b)));
  panel.querySelector('#fb-find-link').addEventListener('click', (e) => {
    const id = panel.querySelector('#fb-find-id').value.trim();
    if (!/^\d+$/.test(id)) { panel.querySelector('#fb-find-msg').innerHTML = `<div class="error-box">The Formbay job number is digits only.</div>`; return; }
    link(id, e.currentTarget);
  });
}

async function fbDrawCreate(panel, project, changed) {
  document.getElementById('formbay-card').style.flex = '1 1 100%';   // the form spreads across the page, not down it
  panel.innerHTML = `<p class="subtitle">Getting the job's details and Formbay's lists...</p>`;
  let o;
  try { o = await fbCall('formbay-create-form', { action: 'options', projectId: project.id }); }
  catch (err) { panel.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`; return; }
  const p = o.prefill;
  const box = (id, label, value, extra = '') => `<div><label style="margin-top:0;">${label}</label><input id="fbc-${id}" value="${escapeHtml(value || '')}" ${extra} /></div>`;
  const opts = (list, picked, blank) => `<option value="">${blank}</option>${list.map(x => `<option value="${escapeHtml(x.value)}" ${x.value === picked ? 'selected' : ''}>${escapeHtml(x.label)}</option>`).join('')}`;
  const streetTypes = Object.keys(o.streetTypes).sort().map(k => ({ value: k, label: `${k} (${o.streetTypes[k]})` }));
  panel.innerHTML = `
    <p class="subtitle" style="margin:0 0 10px;">Filled in from the job. Check it, pick the battery, then Create. It lands in Formbay as a draft: signing and Submit stay in Formbay's app.</p>
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px;">
      ${box('fname', 'Owner first name', p.fname)}${box('sname', 'Owner last name', p.sname)}
      ${box('email', 'Owner email', p.email, 'type="email"')}${box('phone', 'Owner phone', p.phone, 'inputmode="tel"')}
      ${box('unit_number', 'Unit (if any)', p.unit_number)}${box('street_number', 'Street number', p.street_number)}
      ${box('street_name', 'Street name', p.street_name)}
      <div><label style="margin-top:0;">Street type</label><select id="fbc-street_type">${opts(streetTypes, p.street_type, 'Pick one')}</select></div>
      ${box('city', 'Suburb', p.city)}${box('state', 'State', p.state, 'maxlength="3"')}${box('postcode', 'Postcode', p.postcode, 'inputmode="numeric" maxlength="4"')}
      ${box('nmi', 'NMI (optional)', p.nmi, 'inputmode="numeric" placeholder="Formbay finds it from the address"')}
      ${box('date', 'Install date', sydneyDateKey(new Date()), 'type="date"')}
      <div><label style="margin-top:0;">Installer</label><select id="fbc-installer">${opts(o.installers.map(i => ({ value: i.id, label: i.name })), p.installer, 'Pick one')}</select></div>
      <div><label style="margin-top:0;">Battery brand</label><select id="fbc-brand">${opts(o.brands.map(b => ({ value: b, label: b })), p.brand, 'Pick one')}</select></div>
      <div><label style="margin-top:0;">Battery series</label><select id="fbc-series"><option value="">Pick the brand first</option></select></div>
      <div style="grid-column:span 2;"><label style="margin-top:0;">Battery model</label><select id="fbc-model"><option value="">Pick the series first</option></select></div>
      ${box('count', 'How many', '1', 'type="number" min="1" inputmode="numeric"')}
    </div>
    <p class="subtitle" style="margin:8px 0 0;">The installer is also put down as the designer and the electrician; change that in Formbay if it is someone else.</p>
    <div style="display:flex; gap:8px; margin-top:12px; align-items:center; flex-wrap:wrap;">
      <button type="button" id="fbc-go">Create in Formbay</button>
      <div id="fbc-msg" style="flex:1; min-width:200px;"></div>
    </div>`;
  const $ = (id) => panel.querySelector(`#fbc-${id}`);
  const fill = async (action, target, blank, body) => {
    target.innerHTML = `<option value="">Loading...</option>`;
    try {
      const { list } = await fbCall('formbay-create-form', { action, ...body });
      target.innerHTML = opts(list.map(x => ({ value: String(x), label: String(x) })), list.length === 1 ? String(list[0]) : '', blank);
      if (list.length === 1) target.dispatchEvent(new Event('change'));
    } catch (err) { target.innerHTML = `<option value="">${escapeHtml(err.message)}</option>`; }
  };
  $('brand').addEventListener('change', () => {
    $('model').innerHTML = `<option value="">Pick the series first</option>`;
    if ($('brand').value) fill('series', $('series'), 'Pick one', { brand: $('brand').value });
  });
  $('series').addEventListener('change', () => { if ($('series').value) fill('models', $('model'), 'Pick one', { brand: $('brand').value, series: $('series').value }); });
  if (p.brand) $('brand').dispatchEvent(new Event('change'));

  $('go').addEventListener('click', async () => {
    const fields = { commercial: !!p.commercial };
    ['fname', 'sname', 'email', 'phone', 'unit_number', 'street_number', 'street_name', 'street_type', 'city', 'state', 'postcode', 'nmi', 'date', 'installer', 'brand', 'series', 'model', 'count']
      .forEach(k => { fields[k] = $(k).value.trim(); });
    $('go').disabled = true;
    $('msg').innerHTML = `<p class="subtitle" style="margin:0;">Making the form in Formbay...</p>`;
    try {
      const r = await fbCall('formbay-create-form', { action: 'create', projectId: project.id, fields });
      if (r.warning) alert(r.warning);
      await changed();
    } catch (err) {
      $('msg').innerHTML = `<div class="error-box" style="margin:0;">${escapeHtml(err.message)}</div>`;
      $('go').disabled = false;
    }
  });
}
