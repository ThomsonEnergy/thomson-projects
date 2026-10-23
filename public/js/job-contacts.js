// The job page's Contacts tab (docs/PROJECT_SPEC.md A17, backlog item 33): who to call on a
// job, in three groups. On site (owner, renter, builder, other trade), the client's people
// (project manager, site manager, job contact) and ours (site manager, project manager, sales
// manager). Every role reads, adds, edits and removes rows (table job_contacts, migration
// 20261121000000). The Thomson Energy site manager is the one asked "How's the job?" at
// clock-out. Also fills the "Key people" card on the Summary tab. Loaded by project.html;
// needs supabase-client.js (supabaseClient, escapeHtml, logActivity).
(function () {
  const esc = (s) => escapeHtml(s);
  const attr = (s) => esc(s).replace(/"/g, '&quot;');
  const SIDES = [
    { key: 'site', title: 'On site', blurb: 'The people at the site: who lets us in and who the work is for.',
      roles: [['owner', 'Owner'], ['renter', 'Renter'], ['builder', 'Builder'], ['other_trade', 'Other trade'], ['real_estate', 'Real estate agent'], ['strata', 'Strata'], ['other', 'Other']] },
    { key: 'client', title: 'Client', blurb: "The client's people. Booking emails go to the job contact, then the site manager, then the project manager.",
      roles: [['project_manager', 'Project manager'], ['site_manager', 'Site manager'], ['job_contact', 'Job contact'], ['accounts', 'Accounts'], ['sales', 'Sales'], ['other', 'Other']] },
    { key: 'thomson', title: 'Thomson Energy', blurb: 'Our people on this job. The site manager is asked "How\'s the job?" at clock-out (when they have not clocked in that day, the highest site rank on the job is).',
      roles: [['site_manager', 'Site manager'], ['project_manager', 'Project manager'], ['sales_manager', 'Sales manager'], ['other', 'Other']] },
  ];
  // The client's saved contact types map onto the client-side roles.
  const CLIENT_TYPE_TO_ROLE = { project_manager: 'project_manager', site: 'site_manager', job: 'job_contact', accounts: 'accounts', sales: 'sales' };
  const S = { project: null, canPickClientContacts: false, rows: [], staff: null, loaded: false };

  const sideOf = (key) => SIDES.find((s) => s.key === key);
  const roleLabel = (side, role) => { const s = sideOf(side); const r = s && s.roles.find((x) => x[0] === role); return r ? r[1] : role; };
  const telHref = (p) => 'tel:' + String(p || '').replace(/[^\d+]/g, '');
  const nameOf = (r) => r.side === 'thomson' ? ((r.profiles && r.profiles.full_name) || 'Someone') : (r.name || '');
  const phoneOf = (r) => r.side === 'thomson' ? (r.profiles && r.profiles.mobile_number) : r.phone;

  function overlay(html) {
    const o = document.createElement('div');
    o.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:150; padding:16px; overflow-y:auto;';
    o.innerHTML = `<div class="card" style="max-width:520px; width:100%; max-height:92vh; overflow-y:auto;">${html}</div>`;
    document.body.appendChild(o);
    return o;
  }
  const errBox = (el, msg) => { if (el) el.innerHTML = `<div class="error-box">${esc(msg)}</div>`; };

  // ---------- the tab ----------
  function initJobContacts(project, pricingVisible) {
    S.project = project; S.canPickClientContacts = !!pricingVisible && !!project.client_id; S.loaded = false; S.rows = [];
    const tab = document.querySelector('#job-tabs .settings-tab[data-panel="contacts"]');
    if (tab) tab.addEventListener('click', () => { if (!S.loaded) loadJobContacts(project); });
    // The Summary card needs the rows straight away; the tab reuses the same read.
    loadJobContacts(project);
  }

  async function loadJobContacts(project) {
    S.project = project; S.loaded = true;
    const { data, error } = await supabaseClient.from('job_contacts')
      .select('id, side, role, name, company, phone, email, notes, profile_id, client_contact_id, sort_order, created_at, profiles!job_contacts_profile_id_fkey(full_name, mobile_number)')
      .eq('project_id', project.id).order('sort_order').order('created_at');
    if (error) { errBox(document.getElementById('job-contacts-sections'), error.message); return; }
    S.rows = data || [];
    renderSections();
    renderKeyPeople();
  }

  function contactLine(r) {
    const phone = phoneOf(r);
    const bits = [];
    if (r.company) bits.push(esc(r.company));
    if (phone) bits.push(`<a class="link-quiet" href="${attr(telHref(phone))}">${esc(phone)}</a>`);
    if (r.email) bits.push(`<a class="link-quiet" href="mailto:${attr(r.email)}">${esc(r.email)}</a>`);
    return bits.join(' &middot; ');
  }

  function renderSections() {
    const el = document.getElementById('job-contacts-sections');
    if (!el) return;
    el.innerHTML = SIDES.map((s) => {
      const rows = S.rows.filter((r) => r.side === s.key);
      return `
        <div style="margin-bottom:18px;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:4px;">
            <h3 style="margin:0; font-size:15px;">${esc(s.title)}</h3>
            <button type="button" class="secondary js-add" data-side="${s.key}" style="font-size:12px; padding:6px 12px;">+ Add</button>
          </div>
          <p class="subtitle" style="margin:0 0 8px; font-size:12px;">${esc(s.blurb)}</p>
          ${rows.length ? rows.map((r) => `
            <div class="js-row" data-id="${r.id}" style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; padding:8px 0; border-top:1px solid var(--border);">
              <div style="min-width:0;">
                <div><span class="badge draft" style="font-size:10px; margin-right:6px;">${esc(roleLabel(r.side, r.role))}</span><b>${esc(nameOf(r))}</b></div>
                ${contactLine(r) ? `<div style="font-size:13px; margin-top:2px;">${contactLine(r)}</div>` : ''}
                ${r.notes ? `<div class="subtitle" style="font-size:12px; margin-top:2px; white-space:pre-wrap;">${esc(r.notes)}</div>` : ''}
              </div>
              <button type="button" class="secondary js-edit" data-id="${r.id}" style="font-size:12px; padding:4px 10px; flex-shrink:0;">Edit</button>
            </div>`).join('') : `<p class="subtitle" style="font-size:12px; margin:0;">Nobody yet.</p>`}
        </div>`;
    }).join('');
    el.querySelectorAll('.js-add').forEach((b) => b.addEventListener('click', () => openContactForm(b.dataset.side, null)));
    el.querySelectorAll('.js-edit').forEach((b) => b.addEventListener('click', () => {
      const row = S.rows.find((r) => r.id === b.dataset.id);
      if (row) openContactForm(row.side, row);
    }));
  }

  // Summary tab: the three numbers a tradie reaches for. Hidden when the job has no contacts.
  function renderKeyPeople() {
    const card = document.getElementById('job-key-people');
    if (!card) return;
    const first = (side, roles) => {
      for (const role of roles) { const r = S.rows.find((x) => x.side === side && x.role === role); if (r) return r; }
      return S.rows.find((x) => x.side === side) || null;
    };
    const picks = [
      ['Site contact', first('site', ['owner', 'renter', 'builder', 'real_estate', 'strata', 'other_trade', 'other'])],
      ['Client site manager', first('client', ['site_manager', 'project_manager', 'job_contact'])],
      ['Thomson site manager', first('thomson', ['site_manager', 'project_manager'])],
    ].filter((p) => p[1]);
    if (!picks.length) { card.style.display = 'none'; card.innerHTML = ''; return; }
    card.style.display = '';
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <h2 style="margin:0;">Key people</h2>
        <a href="#" class="link-quiet js-go-contacts" style="font-size:12px;">All contacts</a>
      </div>
      ${picks.map(([label, r]) => {
        const phone = phoneOf(r);
        return `<div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:6px 0; border-top:1px solid var(--border);">
          <div style="min-width:0;"><div class="subtitle" style="font-size:11px;">${esc(label)} (${esc(roleLabel(r.side, r.role))})</div><div><b>${esc(nameOf(r))}</b>${r.company ? ` <span class="subtitle">${esc(r.company)}</span>` : ''}</div></div>
          ${phone ? `<a class="btn secondary" href="${attr(telHref(phone))}" style="font-size:12px; padding:6px 12px; flex-shrink:0;">Call</a>` : ''}
        </div>`;
      }).join('')}`;
    const go = card.querySelector('.js-go-contacts');
    if (go) go.addEventListener('click', (e) => { e.preventDefault(); const t = document.querySelector('#job-tabs .settings-tab[data-panel="contacts"]'); if (t) t.click(); });
  }

  // ---------- add / edit ----------
  async function loadStaff() {
    if (S.staff) return S.staff;
    const { data } = await supabaseClient.from('profiles').select('id, full_name, role, site_rank').eq('active', true).order('full_name');
    S.staff = data || [];
    return S.staff;
  }

  async function openContactForm(side, row) {
    const s = sideOf(side);
    if (!s) return;
    const isOurs = side === 'thomson';
    const staff = isOurs ? await loadStaff() : [];
    const role = row ? row.role : s.roles[0][0];
    const ov = overlay(`
      <h2 style="margin:0 0 4px;">${row ? 'Edit' : 'Add'} ${esc(s.title === 'Thomson Energy' ? 'one of ours' : s.title === 'Client' ? "one of the client's people" : 'a site contact')}</h2>
      <p class="subtitle" style="margin:0 0 10px; font-size:12px;">${esc(s.blurb)}</p>
      <label style="margin-top:0;">Role</label>
      <select class="js-role">${s.roles.map(([k, l]) => `<option value="${k}" ${k === role ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      ${isOurs ? `
        <label>Who</label>
        <select class="js-profile"><option value="">Pick a person</option>${staff.map((p) => `<option value="${p.id}" ${row && row.profile_id === p.id ? 'selected' : ''}>${esc(p.full_name || p.id)}</option>`).join('')}</select>
      ` : `
        ${side === 'client' && S.canPickClientContacts && !row ? `<div class="js-pick-wrap" style="margin-top:10px;"><button type="button" class="secondary js-pick-client" style="font-size:12px; padding:6px 12px;">Pick from the client's saved contacts</button></div>` : ''}
        <label>Name</label>
        <input class="js-name" value="${attr(row ? row.name : '')}" placeholder="Name" />
        <label>Company</label>
        <input class="js-company" value="${attr(row ? row.company : '')}" placeholder="e.g. the building company or agency" />
        <label>Phone</label>
        <input class="js-phone" type="tel" value="${attr(row ? row.phone : '')}" placeholder="04xx xxx xxx" />
        <label>Email</label>
        <input class="js-email" type="email" autocapitalize="off" value="${attr(row ? row.email : '')}" placeholder="name@example.com" />
      `}
      <label>Notes</label>
      <textarea class="js-notes" style="min-height:60px;" placeholder="${isOurs ? 'Anything the crew should know' : 'e.g. key in the lockbox, call before 7am'}">${esc(row ? row.notes : '')}</textarea>
      <div class="js-msg" style="margin-top:8px;"></div>
      <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;">
        <button type="button" class="js-save">Save</button>
        <button type="button" class="secondary js-close">Cancel</button>
        ${row ? `<button type="button" class="secondary js-remove" style="margin-left:auto; color:var(--red);">Remove</button>` : ''}
      </div>`);
    let clientContactId = row ? row.client_contact_id : null;
    const msg = ov.querySelector('.js-msg');
    ov.querySelector('.js-close').addEventListener('click', () => ov.remove());

    const pickBtn = ov.querySelector('.js-pick-client');
    if (pickBtn) pickBtn.addEventListener('click', async () => {
      const wrap = ov.querySelector('.js-pick-wrap');
      const { data: contacts, error } = await supabaseClient.from('client_contacts').select('id, contact_type, name, phone, email').eq('client_id', S.project.client_id).order('sort_order');
      if (error) { errBox(msg, error.message); return; }
      if (!contacts || !contacts.length) { wrap.innerHTML = '<p class="subtitle" style="font-size:12px; margin:0;">This client has no saved contacts yet (Clients page).</p>'; return; }
      wrap.innerHTML = `<label style="margin-top:0;">Saved contact</label><select class="js-saved"><option value="">Type one in below</option>${contacts.map((c) => `<option value="${c.id}">${esc(c.name || c.phone || c.email)} (${esc(roleLabel('client', CLIENT_TYPE_TO_ROLE[c.contact_type] || 'other'))})</option>`).join('')}</select>`;
      wrap.querySelector('.js-saved').addEventListener('change', (e) => {
        const c = contacts.find((x) => x.id === e.target.value);
        clientContactId = c ? c.id : null;
        if (!c) return;
        ov.querySelector('.js-name').value = c.name || '';
        ov.querySelector('.js-phone').value = c.phone || '';
        ov.querySelector('.js-email').value = c.email || '';
        const r = CLIENT_TYPE_TO_ROLE[c.contact_type];
        if (r) ov.querySelector('.js-role').value = r;
      });
    });

    ov.querySelector('.js-save').addEventListener('click', async () => {
      const btn = ov.querySelector('.js-save');
      const fields = { side, role: ov.querySelector('.js-role').value, notes: ov.querySelector('.js-notes').value.trim() || null };
      if (isOurs) {
        fields.profile_id = ov.querySelector('.js-profile').value || null;
        if (!fields.profile_id) { errBox(msg, 'Pick a person.'); return; }
        fields.name = null; fields.company = null; fields.phone = null; fields.email = null; fields.client_contact_id = null;
      } else {
        fields.name = ov.querySelector('.js-name').value.trim();
        fields.company = ov.querySelector('.js-company').value.trim() || null;
        fields.phone = ov.querySelector('.js-phone').value.trim() || null;
        fields.email = ov.querySelector('.js-email').value.trim() || null;
        fields.profile_id = null;
        fields.client_contact_id = clientContactId;
        if (!fields.name) { errBox(msg, 'A name is needed.'); return; }
      }
      btn.disabled = true; btn.textContent = 'Saving...';
      try {
        if (row) {
          const { error } = await supabaseClient.from('job_contacts').update(fields).eq('id', row.id);
          if (error) throw error;
        } else {
          const { error } = await supabaseClient.from('job_contacts').insert({ ...fields, project_id: S.project.id, sort_order: S.rows.filter((r) => r.side === side).length });
          if (error) throw error;
          const who = isOurs ? ((staff.find((p) => p.id === fields.profile_id) || {}).full_name || 'someone') : fields.name;
          await logActivity('project', S.project.id, 'contact_added', `Added ${who} as ${s.title === 'Thomson Energy' ? 'Thomson Energy' : s.title.toLowerCase()} ${roleLabel(side, fields.role).toLowerCase()}`);
        }
        ov.remove();
        loadJobContacts(S.project);
      } catch (err) {
        errBox(msg, friendlyContactError(err));
        btn.disabled = false; btn.textContent = 'Save';
      }
    });

    const removeBtn = ov.querySelector('.js-remove');
    if (removeBtn) removeBtn.addEventListener('click', async () => {
      if (!confirm(`Remove ${nameOf(row)} from this job's contacts?`)) return;
      removeBtn.disabled = true;
      const { error } = await supabaseClient.from('job_contacts').delete().eq('id', row.id);
      if (error) { errBox(msg, error.message); removeBtn.disabled = false; return; }
      await logActivity('project', S.project.id, 'contact_removed', `Removed ${nameOf(row)} (${s.title} ${roleLabel(side, row.role).toLowerCase()})`);
      ov.remove();
      loadJobContacts(S.project);
    });
  }

  function friendlyContactError(err) {
    const m = (err && err.message) || String(err);
    if (/job_contacts_one_site_manager_uidx/.test(m)) return 'This job already has a Thomson Energy site manager. Edit that row to change who it is.';
    if (/job_contacts_profile_role_uidx/.test(m)) return 'That person is already listed in that role on this job.';
    return m;
  }

  window.initJobContacts = initJobContacts;
  window.loadJobContacts = loadJobContacts;
})();
