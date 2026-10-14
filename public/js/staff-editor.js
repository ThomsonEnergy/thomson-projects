// The full employee editor (details, photo, licences, rates, allowances,
// employment terms, sensitive details, onboarding re-issue and the
// employment contract), opened from a staff profile (staff.html). Moved out
// of Settings > Users & Roles, which now only creates users and pushes them
// to Xero. Needs supabase-client.js (contract helpers, uploadPhotos).
// openStaffEditor(userId, { onSaved, onClosed }) - onSaved runs after a
// successful Save, onClosed when it's closed without saving.

// Every remaining [bracket] in the contract template becomes an
// actual field here rather than left as raw text to hand-edit - which
// fields show depends on employment type / pay type, same as the
// clause selection itself (see generateContractDraft in
// supabase-client.js).
function contractAnswerFieldsHtml(profile, answers) {
  const fields = [
    ...CONTRACT_ANSWER_FIELDS,
    ...contractHoursFields(profile.employment_type),
    ...contractPayFields(profile),
  ];
  const defaults = { position: profile.job_title || '' };
  return `<div class="grid cols-3" id="contract-answer-fields">
    ${fields.map(f => `
      <div>
        <label style="margin-top:0; font-size:12px;">${f.label}</label>
        <input class="contract-answer-input" data-key="${f.key}" type="${f.type}" ${f.type === 'number' ? 'step="0.01"' : ''}
          placeholder="${f.placeholder || ''}" value="${answers[f.key] ?? defaults[f.key] ?? ''}" />
      </div>`).join('')}
  </div>`;
}

// Re-renders just the answer-field inputs when employment/pay type
// changes, so the right hours/pay questions show without needing to
// save and reopen the panel - carries forward whatever's already
// been typed into fields that survive the switch.
function refreshContractAnswerFields(overlay, baseProfile) {
  const wrap = overlay.querySelector('#contract-answer-fields');
  if (!wrap) return;
  const currentAnswers = {};
  wrap.querySelectorAll('.contract-answer-input').forEach(input => { currentAnswers[input.dataset.key] = input.value; });
  const liveProfile = {
    ...baseProfile,
    employment_type: overlay.querySelector('#profile-employment-type').value,
    pay_type: overlay.querySelector('#profile-pay-type').value,
    salary_includes_super: overlay.querySelector('#profile-salary-inc-super').checked,
  };
  wrap.outerHTML = contractAnswerFieldsHtml(liveProfile, currentAnswers);
}

async function openStaffEditor(userId, opts = {}) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:flex-start; justify-content:center; z-index:100; padding:16px; overflow-y:auto;';
  overlay.innerHTML = `<div class="card" style="max-width:760px; width:100%; margin:20px 0;"><p class="subtitle">Loading...</p></div>`;
  document.body.appendChild(overlay);

  // Pay rates come from a separate secure view, not the profiles row
  // directly - the base table's rate columns are locked to admin/
  // finance (or the row's own owner) at the database level, so a
  // direct select on profiles can no longer see them at all.
  const { data: profile, error } = await supabaseClient.from('profiles')
    .select(`id, full_name, role, active, mobile_number, notes, photo_url, rate_tier_id,
      employment_type, employment_start_date, pay_type, salary_includes_super, has_company_vehicle, has_probationary_period,
      emergency_contact_name, emergency_contact_relationship, onboarding_completed_at, onboarding_reissue_reason`)
    .eq('id', userId).single();
  const { data: rates } = await supabaseClient.from('profiles_pay_rates_secure').select('*').eq('id', userId).maybeSingle();
  const { data: sensitive } = await supabaseClient.from('profiles_sensitive_secure').select('*').eq('id', userId).maybeSingle();
  const { data: licences } = await supabaseClient.from('profile_licences').select('*').eq('profile_id', userId).order('expiry_date');
  const { data: allowances } = await supabaseClient.from('employee_allowances').select('*').eq('profile_id', userId);
  const { data: rateTiers } = await supabaseClient.from('billable_rate_tiers').select('*').order('sort_order');
  const { data: contract } = await supabaseClient.from('employee_contracts').select('*').eq('profile_id', userId).maybeSingle();
  const { data: contractTemplate } = await supabaseClient.from('onboarding_documents').select('*').eq('is_contract', true).maybeSingle();
  if (error) { overlay.querySelector('.card').innerHTML = `<div class="error-box">${error.message}</div>`; return; }
  if (rates) Object.assign(profile, rates);
  if (sensitive) Object.assign(profile, sensitive);

  function renderLicenceRows(list) {
    return (list || []).map(l => `
      <div class="licence-row" data-id="${l.id}" style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
        <input class="licence-name" value="${l.licence_name || ''}" placeholder="Licence name" style="flex:2;" />
        <input class="licence-number" value="${l.licence_number || ''}" placeholder="Number" style="flex:1;" />
        <input class="licence-expiry" type="date" value="${l.expiry_date || ''}" style="flex:1;" />
        <button type="button" class="secondary remove-licence-btn" style="padding:8px 10px;">&times;</button>
      </div>`).join('');
  }

  function renderAllowanceRows(list) {
    return (list || []).map(a => `
      <div class="allowance-row" data-id="${a.id}" style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
        <input class="allowance-name" value="${a.name || ''}" placeholder="e.g. Company car" style="flex:2;" />
        <input class="allowance-amount" type="number" step="0.01" value="${a.amount || ''}" placeholder="$" style="flex:1;" />
        <select class="allowance-frequency" style="flex:1;">
          <option value="per_day" ${a.frequency === 'per_day' ? 'selected' : ''}>Per day</option>
          <option value="per_hour" ${a.frequency === 'per_hour' ? 'selected' : ''}>Per hour</option>
        </select>
        <button type="button" class="secondary remove-allowance-btn" style="padding:8px 10px;">&times;</button>
      </div>`).join('');
  }

  overlay.querySelector('.card').innerHTML = `
    <h2>${profile.full_name || 'User profile'}</h2>
    <div style="display:flex; gap:16px; align-items:start; margin-bottom:10px;">
      <img id="profile-photo-preview" src="${profile.photo_url || ''}" style="width:80px; height:80px; border-radius:50%; object-fit:cover; background:var(--surface-2); display:${profile.photo_url ? 'block' : 'none'};" />
      <div style="flex:1;">
        <label style="margin-top:0">Photo</label>
        <input type="file" id="profile-photo-input" accept="image/*" />
      </div>
    </div>

    <label>Name</label>
    <input id="profile-name-input" value="${profile.full_name || ''}" />

    <label>Mobile number</label>
    <input id="profile-mobile-input" value="${profile.mobile_number || ''}" />

    <label>Notes</label>
    <textarea id="profile-notes-input" style="min-height:70px;">${profile.notes || ''}</textarea>

    <label style="margin-top:14px;">Industry licences</label>
    <div id="licence-rows">${renderLicenceRows(licences)}</div>
    <button type="button" class="secondary" id="add-licence-btn" style="font-size:12px; padding:6px 10px;">+ Add licence</button>

    <div style="margin-top:20px; padding-top:16px; border-top:0.5px solid var(--border);">
      <label style="margin-top:0">Rate tier (for quoting - see Settings &gt; Billable Rates)</label>
      <select id="profile-tier-select">
        <option value="">-- None --</option>
        ${(rateTiers || []).map(t => `<option value="${t.id}" ${profile.rate_tier_id === t.id ? 'selected' : ''}>${t.name}</option>`).join('')}
      </select>

      <p class="subtitle" style="margin:14px 0 8px;">Actual pay rates - entered directly since award overtime rarely equals a clean multiple of ordinary time. Used to calculate real job costs from logged hours.</p>
      <div class="grid cols-4">
        <div>
          <label style="margin-top:0">Ordinary hours ($/hr)</label>
          <input id="profile-rate-ordinary" type="number" step="0.01" value="${profile.ordinary_rate || ''}" />
        </div>
        <div>
          <label style="margin-top:0">Overtime - first 2hrs ($/hr)</label>
          <input id="profile-rate-1-5x" type="number" step="0.01" value="${profile.rate_1_5x || ''}" />
        </div>
        <div>
          <label style="margin-top:0">Overtime - after that ($/hr)</label>
          <input id="profile-rate-2x" type="number" step="0.01" value="${profile.rate_2x || ''}" />
        </div>
        <div>
          <label style="margin-top:0">Public holiday ($/hr)</label>
          <input id="profile-rate-2-5x" type="number" step="0.01" value="${profile.rate_2_5x || ''}" />
        </div>
      </div>

      <label style="margin-top:14px;">Allowances</label>
      <div id="allowance-rows">${renderAllowanceRows(allowances)}</div>
      <button type="button" class="secondary" id="add-allowance-btn" style="font-size:12px; padding:6px 10px;">+ Add allowance</button>
    </div>

    <div style="margin-top:20px; padding-top:16px; border-top:0.5px solid var(--border);">
      <p style="margin:0 0 10px; font-weight:600;">Onboarding &amp; payroll ${profile.onboarding_completed_at ? '<span class="badge accepted" style="font-weight:400;">Onboarding complete</span>' : '<span class="badge draft" style="font-weight:400;">Onboarding not started</span>'}${profile.onboarding_reissue_reason ? ' <span class="badge sent" style="font-weight:400;">Re-issue pending</span>' : ''}</p>

      ${profile.onboarding_completed_at ? `
        <div style="padding:12px; background:var(--surface-2); border-radius:8px; margin-bottom:12px;">
          <label style="margin-top:0">Re-issue onboarding - sends them back through it (updated pay rates and any new contract show automatically)</label>
          <div class="grid cols-2">
            <select id="reissue-reason">
              <option value="pay_rise">Pay rise</option>
              <option value="details_update">Update details</option>
              <option value="other">Other</option>
            </select>
            <input id="reissue-note" placeholder="Optional note shown to them" />
          </div>
          <label style="display:flex; align-items:center; gap:8px; margin-top:8px;">
            <input type="checkbox" id="reissue-needs-contract" style="width:auto;" checked /> Needs a new contract sign-off (resets it to draft for you to regenerate)
          </label>
          <button type="button" class="secondary" id="reissue-btn" style="margin-top:8px; font-size:12px; padding:6px 10px;">Re-issue onboarding</button>
          <div id="reissue-msg"></div>
        </div>
      ` : ''}

      <div class="grid cols-3">
        <div>
          <label style="margin-top:0">Employment type</label>
          <select id="profile-employment-type">
            <option value="">-- Not set --</option>
            <option value="full_time" ${profile.employment_type === 'full_time' ? 'selected' : ''}>Full-time</option>
            <option value="part_time" ${profile.employment_type === 'part_time' ? 'selected' : ''}>Part-time</option>
            <option value="casual" ${profile.employment_type === 'casual' ? 'selected' : ''}>Casual</option>
          </select>
        </div>
        <div>
          <label style="margin-top:0">Start date</label>
          <input type="date" id="profile-start-date" value="${profile.employment_start_date || ''}" />
        </div>
        <div>
          <label style="margin-top:0">Pay type</label>
          <select id="profile-pay-type">
            <option value="hourly" ${profile.pay_type !== 'salary' ? 'selected' : ''}>Hourly</option>
            <option value="salary" ${profile.pay_type === 'salary' ? 'selected' : ''}>Salary</option>
          </select>
        </div>
      </div>
      <div class="grid cols-4" style="margin-top:10px;">
        <div>
          <label style="margin-top:0">Annual salary (if salaried)</label>
          <input type="number" step="0.01" id="profile-annual-salary" value="${profile.annual_salary || ''}" />
        </div>
        <div>
          <label style="margin-top:22px; display:flex; align-items:center; gap:8px;">
            <input type="checkbox" id="profile-salary-inc-super" style="width:auto;" ${profile.salary_includes_super !== false ? 'checked' : ''} /> Salary includes super
          </label>
        </div>
        <div>
          <label style="margin-top:22px; display:flex; align-items:center; gap:8px;">
            <input type="checkbox" id="profile-has-vehicle" style="width:auto;" ${profile.has_company_vehicle ? 'checked' : ''} /> Gets a company vehicle
          </label>
        </div>
        <div>
          <label style="margin-top:22px; display:flex; align-items:center; gap:8px;">
            <input type="checkbox" id="profile-has-probation" style="width:auto;" ${profile.has_probationary_period !== false ? 'checked' : ''} /> Has a probationary period
          </label>
        </div>
      </div>

      <p class="subtitle" style="margin:14px 0 8px;">Sensitive - visible here and to the person themself only. Mostly filled in by the employee via their own onboarding. Tax file number, super, and bank details aren't collected here at all - send the employee a direct self-service invite from Xero for those once they're set up there.</p>
      <div class="grid cols-2">
        <div>
          <label style="margin-top:0">Date of birth</label>
          <input type="date" id="profile-dob" value="${profile.date_of_birth || ''}" />
        </div>
      </div>
      <label style="margin-top:10px;">Residential address</label>
      <input id="profile-address" value="${profile.residential_address || ''}" />
      <div class="grid cols-2" style="margin-top:10px;">
        <div>
          <label style="margin-top:0">Emergency contact</label>
          <input id="profile-emergency-name" value="${profile.emergency_contact_name || ''}" placeholder="Name" />
        </div>
        <div>
          <label style="margin-top:0">Relationship</label>
          <input id="profile-emergency-relationship" value="${profile.emergency_contact_relationship || ''}" />
        </div>
      </div>
    </div>

    <div style="margin-top:20px; padding-top:16px; border-top:0.5px solid var(--border);">
      <p style="margin:0 0 8px; font-weight:600;">Employment contract ${contract ? `<span class="badge ${contract.status === 'signed' ? 'accepted' : contract.status === 'ready_to_sign' ? 'sent' : 'draft'}" style="font-weight:400;">${contract.status.replace('_', ' ')}</span>` : ''}</p>
      <p class="subtitle" style="margin-bottom:8px;">Fills in the contract template against the fields above plus these - edit the raw template under Settings &gt; Onboarding Documents if the wording itself needs to change. Review the generated draft below and edit anything it couldn't resolve, then mark ready to sign - the employee only sees it once you do.</p>
      ${contractAnswerFieldsHtml(profile, (contract && contract.answers) || {})}
      <button type="button" class="secondary" id="generate-contract-btn" style="font-size:12px; padding:6px 10px; margin:10px 0 8px;" ${contractTemplate ? '' : 'disabled'}>${contract ? 'Regenerate draft' : 'Generate draft'}</button>
      <textarea id="profile-contract-body" style="min-height:220px; font-family:monospace; font-size:12px; ${contract ? '' : 'display:none;'}">${contract ? contract.generated_body : ''}</textarea>
      <div style="margin-top:8px; display:${contract ? 'flex' : 'none'}; gap:8px;" id="contract-action-row">
        <button type="button" class="secondary" id="save-contract-draft-btn" style="font-size:12px; padding:6px 10px;">Save draft</button>
        <button type="button" class="secondary" id="mark-contract-ready-btn" style="font-size:12px; padding:6px 10px;" ${contract && contract.status === 'ready_to_sign' ? 'disabled' : ''}>Mark ready to sign</button>
      </div>
      <div id="contract-msg"></div>
    </div>


    <div style="margin-top:16px;">
      <button id="save-profile-btn">Save</button>
      <button type="button" class="secondary" id="close-profile-btn">Close</button>
    </div>
    <div id="profile-panel-msg"></div>`;

  overlay.querySelector('#profile-photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const [url] = await uploadPhotos([file], 'staff-photos');
      overlay.querySelector('#profile-photo-preview').src = url;
      overlay.querySelector('#profile-photo-preview').style.display = 'block';
      overlay.querySelector('#profile-photo-preview').dataset.newUrl = url;
    } catch (err) {
      alert('Photo upload failed: ' + err.message);
    }
  });

  overlay.querySelector('#add-licence-btn').addEventListener('click', () => {
    overlay.querySelector('#licence-rows').insertAdjacentHTML('beforeend', renderLicenceRows([{ id: '', licence_name: '', licence_number: '', expiry_date: '' }]));
    wireLicenceRemoveButtons();
  });

  function wireLicenceRemoveButtons() {
    overlay.querySelectorAll('.remove-licence-btn').forEach(btn => {
      btn.onclick = () => btn.closest('.licence-row').remove();
    });
  }
  wireLicenceRemoveButtons();

  overlay.querySelector('#add-allowance-btn').addEventListener('click', () => {
    overlay.querySelector('#allowance-rows').insertAdjacentHTML('beforeend', renderAllowanceRows([{ id: '', name: '', amount: '', frequency: 'per_day' }]));
    wireAllowanceRemoveButtons();
  });

  function wireAllowanceRemoveButtons() {
    overlay.querySelectorAll('.remove-allowance-btn').forEach(btn => {
      btn.onclick = () => btn.closest('.allowance-row').remove();
    });
  }
  wireAllowanceRemoveButtons();


  ['#profile-employment-type', '#profile-pay-type', '#profile-salary-inc-super'].forEach(sel => {
    overlay.querySelector(sel).addEventListener('change', () => refreshContractAnswerFields(overlay, profile));
  });

  // Contract and re-issue buttons save on their own, so refresh on close too.
  overlay.querySelector('#close-profile-btn').addEventListener('click', () => { overlay.remove(); if (opts.onClosed) opts.onClosed(); });
  overlay.querySelector('#save-profile-btn').addEventListener('click', async () => {
    const msg = overlay.querySelector('#profile-panel-msg');
    const saveBtn = overlay.querySelector('#save-profile-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      const photoPreview = overlay.querySelector('#profile-photo-preview');
      const updates = {
        full_name: overlay.querySelector('#profile-name-input').value.trim() || null,
        mobile_number: overlay.querySelector('#profile-mobile-input').value.trim() || null,
        notes: overlay.querySelector('#profile-notes-input').value.trim() || null,
        rate_tier_id: overlay.querySelector('#profile-tier-select').value || null,
        ordinary_rate: parseFloat(overlay.querySelector('#profile-rate-ordinary').value) || null,
        rate_1_5x: parseFloat(overlay.querySelector('#profile-rate-1-5x').value) || null,
        rate_2x: parseFloat(overlay.querySelector('#profile-rate-2x').value) || null,
        rate_2_5x: parseFloat(overlay.querySelector('#profile-rate-2-5x').value) || null,
        employment_type: overlay.querySelector('#profile-employment-type').value || null,
        employment_start_date: overlay.querySelector('#profile-start-date').value || null,
        pay_type: overlay.querySelector('#profile-pay-type').value,
        annual_salary: parseFloat(overlay.querySelector('#profile-annual-salary').value) || null,
        salary_includes_super: overlay.querySelector('#profile-salary-inc-super').checked,
        has_company_vehicle: overlay.querySelector('#profile-has-vehicle').checked,
        has_probationary_period: overlay.querySelector('#profile-has-probation').checked,
        date_of_birth: overlay.querySelector('#profile-dob').value || null,
        residential_address: overlay.querySelector('#profile-address').value.trim() || null,
        emergency_contact_name: overlay.querySelector('#profile-emergency-name').value.trim() || null,
        emergency_contact_relationship: overlay.querySelector('#profile-emergency-relationship').value.trim() || null,
      };
      if (photoPreview.dataset.newUrl) updates.photo_url = photoPreview.dataset.newUrl;

      const { error: updErr } = await supabaseClient.from('profiles').update(updates).eq('id', userId);
      if (updErr) throw updErr;

      // Replace all licences with whatever's currently in the form -
      // simplest way to handle add/edit/remove in one save, given how
      // few licences a person typically has.
      // Keep each licence's uploaded file (added on the Team page) across the
      // replace - the rows here only edit name, number and expiry.
      const keptFiles = Object.fromEntries((licences || []).map(l => [l.id, { file_path: l.file_path || null, file_name: l.file_name || null }]));
      await supabaseClient.from('profile_licences').delete().eq('profile_id', userId);
      const newLicences = [...overlay.querySelectorAll('.licence-row')]
        .map(row => ({
          ...(keptFiles[row.dataset.id] || {}),
          profile_id: userId,
          licence_name: row.querySelector('.licence-name').value.trim(),
          licence_number: row.querySelector('.licence-number').value.trim() || null,
          expiry_date: row.querySelector('.licence-expiry').value || null,
        }))
        .filter(l => l.licence_name);
      if (newLicences.length) {
        const { error: licErr } = await supabaseClient.from('profile_licences').insert(newLicences);
        if (licErr) throw licErr;
      }

      // Same replace-all approach for allowances.
      await supabaseClient.from('employee_allowances').delete().eq('profile_id', userId);
      const newAllowances = [...overlay.querySelectorAll('.allowance-row')]
        .map(row => ({
          profile_id: userId,
          name: row.querySelector('.allowance-name').value.trim(),
          amount: parseFloat(row.querySelector('.allowance-amount').value) || 0,
          frequency: row.querySelector('.allowance-frequency').value,
        }))
        .filter(a => a.name && a.amount > 0);
      if (newAllowances.length) {
        const { error: allowErr } = await supabaseClient.from('employee_allowances').insert(newAllowances);
        if (allowErr) throw allowErr;
      }

      overlay.remove();
      if (opts.onSaved) await opts.onSaved();
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${err.message}</div>`;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });

  overlay.querySelector('#generate-contract-btn').addEventListener('click', async () => {
    const msg = overlay.querySelector('#contract-msg');
    if (!contractTemplate) { msg.innerHTML = `<div class="error-box">No contract template found - add one under Settings &gt; Onboarding Documents first.</div>`; return; }

    // Use whatever's currently in the form, not just what was loaded
    // when the panel opened - lets employment type/pay type/vehicle
    // be set and the contract generated in one go.
    const liveProfile = {
      ...profile,
      employment_type: overlay.querySelector('#profile-employment-type').value,
      pay_type: overlay.querySelector('#profile-pay-type').value,
      annual_salary: parseFloat(overlay.querySelector('#profile-annual-salary').value) || null,
      // the four pay rates and the start date as they are in the form right now,
      // so a contract can be generated straight after typing them in (before Save)
      ordinary_rate: parseFloat(overlay.querySelector('#profile-rate-ordinary').value) || null,
      rate_1_5x: parseFloat(overlay.querySelector('#profile-rate-1-5x').value) || null,
      rate_2x: parseFloat(overlay.querySelector('#profile-rate-2x').value) || null,
      rate_2_5x: parseFloat(overlay.querySelector('#profile-rate-2-5x').value) || null,
      employment_start_date: overlay.querySelector('#profile-start-date').value || null,
      salary_includes_super: overlay.querySelector('#profile-salary-inc-super').checked,
      has_company_vehicle: overlay.querySelector('#profile-has-vehicle').checked,
      has_probationary_period: overlay.querySelector('#profile-has-probation').checked,
      residential_address: overlay.querySelector('#profile-address').value.trim() || null,
    };
    if (!liveProfile.employment_type) { msg.innerHTML = `<div class="error-box">Set an employment type above first (it drives which contract clauses apply).</div>`; return; }

    const answers = {};
    overlay.querySelectorAll('.contract-answer-input').forEach(input => { answers[input.dataset.key] = input.value.trim(); });

    const draftBody = generateContractDraft(liveProfile, contractTemplate.body, answers);
    const { error: contractErr } = await supabaseClient.from('employee_contracts')
      .upsert({ profile_id: userId, generated_body: draftBody, answers, status: 'draft', updated_at: new Date().toISOString() }, { onConflict: 'profile_id' });
    if (contractErr) { msg.innerHTML = `<div class="error-box">${contractErr.message}</div>`; return; }
    overlay.querySelector('#profile-contract-body').value = draftBody;
    overlay.querySelector('#profile-contract-body').style.display = 'block';
    overlay.querySelector('#contract-action-row').style.display = 'flex';
    overlay.querySelector('#mark-contract-ready-btn').disabled = false;
    msg.innerHTML = `<div class="success-box">Draft generated - give it a read before marking it ready to sign, particularly anything still in [brackets] it couldn't resolve. You can leave the employee's address as [insert employee address]: it is filled in from their own details when they open the contract to sign.</div>`;
  });

  overlay.querySelector('#save-contract-draft-btn').addEventListener('click', async () => {
    const msg = overlay.querySelector('#contract-msg');
    const { error: saveErr } = await supabaseClient.from('employee_contracts')
      .update({ generated_body: overlay.querySelector('#profile-contract-body').value, updated_at: new Date().toISOString() })
      .eq('profile_id', userId);
    msg.innerHTML = saveErr ? `<div class="error-box">${saveErr.message}</div>` : `<div class="success-box">Draft saved.</div>`;
  });

  overlay.querySelector('#mark-contract-ready-btn').addEventListener('click', async () => {
    const msg = overlay.querySelector('#contract-msg');
    const { error: readyErr } = await supabaseClient.from('employee_contracts')
      .update({ generated_body: overlay.querySelector('#profile-contract-body').value, status: 'ready_to_sign', updated_at: new Date().toISOString() })
      .eq('profile_id', userId);
    if (readyErr) { msg.innerHTML = `<div class="error-box">${readyErr.message}</div>`; return; }
    msg.innerHTML = `<div class="success-box">Ready to sign - it'll now show up in this person's onboarding.</div>`;
    overlay.querySelector('#mark-contract-ready-btn').disabled = true;
  });

  // Sends someone who's already onboarded back through it - old
  // signatures stay on record (see "My Profile > Documents I've
  // signed"), but everything needs a fresh signature from
  // onboarding_cycle_started_at onward, and Documents step 3 stays
  // hidden until they've done that.
  const reissueBtn = overlay.querySelector('#reissue-btn');
  if (reissueBtn) {
    reissueBtn.addEventListener('click', async () => {
      const msg = overlay.querySelector('#reissue-msg');
      reissueBtn.disabled = true;
      try {
        const { error: profileErr } = await supabaseClient.from('profiles').update({
          onboarding_completed_at: null,
          onboarding_cycle_started_at: new Date().toISOString(),
          onboarding_reissue_reason: overlay.querySelector('#reissue-reason').value,
          onboarding_reissue_note: overlay.querySelector('#reissue-note').value.trim() || null,
        }).eq('id', userId);
        if (profileErr) throw profileErr;

        if (overlay.querySelector('#reissue-needs-contract').checked && contract) {
          const { error: contractErr } = await supabaseClient.from('employee_contracts')
            .update({ status: 'draft', updated_at: new Date().toISOString() }).eq('profile_id', userId);
          if (contractErr) throw contractErr;
        }
        msg.innerHTML = `<div class="success-box">Re-issued - they'll be sent through onboarding again next time they log in.</div>`;
        reissueBtn.textContent = 'Re-issue onboarding';
      } catch (err) {
        msg.innerHTML = `<div class="error-box">${err.message}</div>`;
        reissueBtn.disabled = false;
      }
    });
  }
}

