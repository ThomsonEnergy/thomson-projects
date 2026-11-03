// The job page's Time tab and its accrued cost pop-up (backlog item 42, docs/PROJECT_SPEC.md A13d).
// Downloaded the first time either is opened (withJobTime in project.html). The Time tab: every clocked shift on the job,
// grouped by day, with start, finish, break, paid hours, stage, a ServiceM8 badge and an SI badge when an
// invoice line already bills it. Totals per person on top. Cost per shift for Admin and Finance only
// (from get-itemised-labour-cost). Admin can fix a shift's stage or category, fix or delete a ServiceM8
// shift, and move one or more shifts to another job; every write goes through
// /.netlify/functions/admin-update-time-entry (requireAdmin, server checks in _shared/time-entry-moves.js).
// Staff see only their own shifts (time_entries RLS). Loaded by project.html; needs supabase-client.js
// (supabaseClient, escapeHtml, money, friendlyError, getMyRole, timeCategoryLabel, timeCategoryOptionsHtml, NONJOB_TIME_CATEGORIES,
// sydneyOffsetMinutesAt) and the page's entryHours, loadProject and render.
(function () {
  const SYD = 'Australia/Sydney';
  const esc = (s) => escapeHtml(s);
  const S = { project: null, pricingVisible: false, role: null, entries: [], cost: new Map(), billed: {}, picked: new Set() };

  const sydKey = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: SYD });
  const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-AU', { timeZone: SYD, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-AU', { timeZone: SYD, hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
  const hoursOf = (e) => (e.clock_out ? Math.round(entryHours(e) * 100) / 100 : null);
  const isAdmin = () => S.role === 'admin';
  const seesCost = () => S.role === 'admin' || S.role === 'finance';
  const jobRef = (p) => (p.job_number ? `J${p.job_number}` : p.quote_number ? `Q${p.quote_number}` : '') + (p.name ? ` - ${p.name}` : '');

  async function call(body) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const res = await fetch('/.netlify/functions/admin-update-time-entry', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Failed (${res.status})`);
    return data;
  }

  const centres = () => (S.project.cost_centres || []).slice().sort((a, b) => a.sort_order - b.sort_order);
  function stageLabel(e) {
    if (e.time_category && e.time_category !== 'job') return timeCategoryLabel(e.time_category);
    const ids = e.selected_cost_centre_ids && e.selected_cost_centre_ids.length ? e.selected_cost_centre_ids : (e.cost_centre_id ? [e.cost_centre_id] : []);
    return ids.length ? ids.map((id) => (centres().find((c) => c.id === id) || {}).name || 'Unknown stage').join(', ') : 'Unassigned';
  }

  // ---------- the tab ----------
  function initJobTime(project, pricingVisible) {
    const tab = document.querySelector('#job-tabs .settings-tab[data-panel="time"]');
    if (!tab) return;
    S.project = project; S.pricingVisible = !!pricingVisible; S.picked = new Set();
    let loaded = false;
    tab.addEventListener('click', () => { if (!loaded) { loaded = true; loadJobTime(); } });
    if (new URLSearchParams(window.location.search).get('tab') === 'time') tab.click();
  }

  async function loadJobTime() {
    const body = document.getElementById('job-time-body');
    if (!body) return;
    if (!S.role) S.role = await getMyRole();
    const { data, error } = await supabaseClient.from('time_entries')
      .select('id, staff_id, clock_in, clock_out, break_minutes, cost_centre_id, selected_cost_centre_ids, time_category, sm8_activity_uuid, profiles(full_name)')
      .eq('project_id', S.project.id).order('clock_in', { ascending: false });
    if (error) { body.innerHTML = `<div class="error-box">${esc(friendlyError(error))}</div>`; return; }
    S.entries = data || [];
    S.cost = new Map(); S.billed = {};
    const ids = S.entries.map((e) => e.id);
    await Promise.all([
      (async () => {
        if (!seesCost() || !ids.length) return;
        try {
          const { data: { session } } = await supabaseClient.auth.getSession();
          const res = await fetch('/.netlify/functions/get-itemised-labour-cost', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ projectId: S.project.id }),
          });
          const d = await res.json();
          if (res.ok && d.ok) S.cost = new Map(Object.entries(d.costByEntryId || {}));
        } catch (err) { console.error('Itemised labour cost fetch failed:', err.message); }
      })(),
      (async () => {
        if (!S.pricingVisible || !ids.length) return; // invoice lines are pricing roles only
        const { data: lines } = await supabaseClient.from('invoice_line_items').select('time_entry_ids, invoices(invoice_number)').overlaps('time_entry_ids', ids);
        for (const l of lines || []) for (const id of l.time_entry_ids || []) if (ids.includes(id)) S.billed[id] = l.invoices?.invoice_number || 'an invoice';
      })(),
    ]);
    S.picked = new Set([...S.picked].filter((id) => ids.includes(id)));
    renderTime();
  }

  function renderTime() {
    const body = document.getElementById('job-time-body');
    if (!S.entries.length) { body.innerHTML = '<p class="subtitle">No shifts clocked on this job yet.</p>'; return; }

    const people = new Map();
    for (const e of S.entries) {
      const p = people.get(e.staff_id) || { name: e.profiles?.full_name || 'Unknown', hours: 0, cost: 0, shifts: 0 };
      p.hours += hoursOf(e) || 0; p.cost += S.cost.get(e.id) || 0; p.shifts += 1;
      people.set(e.staff_id, p);
    }
    const totalH = [...people.values()].reduce((s, p) => s + p.hours, 0);
    const totalC = [...people.values()].reduce((s, p) => s + p.cost, 0);
    const summary = `
      <table class="responsive-stack" style="margin-bottom:16px;">
        <thead><tr><th>Person</th><th class="num">Shifts</th><th class="num">Hours</th>${seesCost() ? '<th class="num">Cost</th>' : ''}</tr></thead>
        <tbody>${[...people.values()].sort((a, b) => b.hours - a.hours).map((p) => `
          <tr><td data-label="Person">${esc(p.name)}</td><td class="num" data-label="Shifts">${p.shifts}</td><td class="num" data-label="Hours">${p.hours.toFixed(2)}</td>${seesCost() ? `<td class="num" data-label="Cost">${money(p.cost)}</td>` : ''}</tr>`).join('')}</tbody>
        <tfoot><tr><td style="font-weight:600;">Total</td><td class="num">${S.entries.length}</td><td class="num" style="font-weight:600;">${totalH.toFixed(2)}</td>${seesCost() ? `<td class="num" style="font-weight:600;">${money(totalC)}</td>` : ''}</tr></tfoot>
      </table>`;

    const days = [];
    for (const e of S.entries) {
      const k = sydKey(e.clock_in);
      if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, label: fmtDay(e.clock_in), rows: [] });
      days[days.length - 1].rows.push(e);
    }
    const bar = isAdmin() ? `
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
        <label style="display:flex; align-items:center; gap:6px; margin:0; font-weight:400;"><input type="checkbox" id="jt-all" style="width:auto;" /> Tick all</label>
        <button type="button" id="jt-move-btn" style="font-size:12px; padding:6px 12px;" ${S.picked.size ? '' : 'disabled'}>Move ticked to another job${S.picked.size ? ` (${S.picked.size})` : ''}</button>
      </div>
      <div id="jt-move-panel"></div>` : '';

    body.innerHTML = summary + bar + days.map((d) => `
      <h3 style="margin:16px 0 6px;">${esc(d.label)}</h3>
      ${d.rows.map((e) => {
        const h = hoursOf(e);
        const cost = S.cost.get(e.id);
        const billed = S.billed[e.id];
        return `
        <div class="jt-row" data-id="${esc(e.id)}" style="display:flex; align-items:flex-start; gap:10px; padding:8px 0; border-bottom:1px solid var(--border);">
          ${isAdmin() ? `<input type="checkbox" class="jt-pick" data-id="${esc(e.id)}" style="width:auto; margin-top:4px;" ${S.picked.has(e.id) ? 'checked' : ''} ${!e.clock_out || billed ? 'disabled' : ''} />` : ''}
          <div style="flex:1; min-width:0;">
            <div style="font-weight:600;">${esc(e.profiles?.full_name || 'Unknown')}</div>
            <div class="meta">${fmtTime(e.clock_in)} to ${e.clock_out ? fmtTime(e.clock_out) : 'still clocked in'}${Number(e.break_minutes) ? ` &middot; ${Number(e.break_minutes)} min break` : ''} &middot; ${esc(stageLabel(e))}</div>
            <div style="margin-top:4px; display:flex; gap:6px; flex-wrap:wrap;">
              ${e.sm8_activity_uuid ? '<span class="badge draft">ServiceM8, already paid</span>' : ''}
              ${billed ? `<span class="badge approved" title="Billed on an invoice: it stays on this job">billed on ${esc(billed)}</span>` : ''}
            </div>
            <div class="jt-edit" data-edit-for="${esc(e.id)}"></div>
          </div>
          <div style="text-align:right; min-width:90px;">
            <div style="font-weight:600;">${h === null ? 'In progress' : h.toFixed(2) + 'h'}</div>
            ${seesCost() ? `<div class="meta">${cost === undefined ? '-' : money(cost)}</div>` : ''}
            ${isAdmin() ? `<button type="button" class="secondary jt-edit-btn" data-id="${esc(e.id)}" style="font-size:12px; padding:4px 8px; margin-top:4px;">Edit</button>` : ''}
          </div>
        </div>`;
      }).join('')}`).join('');

    if (!isAdmin()) return;
    body.querySelectorAll('.jt-pick').forEach((cb) => cb.addEventListener('change', () => {
      if (cb.checked) S.picked.add(cb.dataset.id); else S.picked.delete(cb.dataset.id);
      updateMoveBtn();
    }));
    const all = document.getElementById('jt-all');
    all.addEventListener('change', () => {
      body.querySelectorAll('.jt-pick:not(:disabled)').forEach((cb) => { cb.checked = all.checked; if (all.checked) S.picked.add(cb.dataset.id); else S.picked.delete(cb.dataset.id); });
      updateMoveBtn();
    });
    document.getElementById('jt-move-btn').addEventListener('click', () => openMovePanel([...S.picked]));
    body.querySelectorAll('.jt-edit-btn').forEach((b) => b.addEventListener('click', () => openEditRow(S.entries.find((e) => e.id === b.dataset.id))));
  }

  function updateMoveBtn() {
    const btn = document.getElementById('jt-move-btn');
    if (!btn) return;
    btn.disabled = !S.picked.size;
    btn.textContent = `Move ticked to another job${S.picked.size ? ` (${S.picked.size})` : ''}`;
  }

  // After any change: this tab, then the page (stage and Summary costs), then back on this tab.
  async function afterChange() {
    S.picked = new Set();
    const refreshed = await loadProject();
    if (refreshed) {
      render(refreshed, S.pricingVisible);
      const tab = document.querySelector('#job-tabs .settings-tab[data-panel="time"]');
      if (tab) tab.click(); else await loadJobTime();
    } else {
      await loadJobTime();
    }
  }

  // ---------- move to another job ----------
  function openMovePanel(ids) {
    const panel = document.getElementById('jt-move-panel');
    if (!panel || !ids.length) return;
    const hrs = ids.reduce((s, id) => s + (hoursOf(S.entries.find((e) => e.id === id)) || 0), 0);
    panel.innerHTML = `
      <div style="padding:12px; background:var(--surface-2); border-radius:8px; margin-bottom:12px;">
        <p style="margin:0 0 6px;"><b>Move ${ids.length} shift${ids.length === 1 ? '' : 's'} (${hrs.toFixed(2)}h)</b>. Hours and pay stay the same; only the job carrying the cost changes.</p>
        <label style="margin-top:0;">Category</label>
        <select class="jt-mv-cat"><option value="job">A job</option>${NONJOB_TIME_CATEGORIES.filter((c) => c.value !== 'tafe').map((c) => `<option value="${c.value}">${esc(c.label)}</option>`).join('')}</select>
        <div class="jt-mv-job">
          <label>Which job? (J number, client or job name)</label>
          <input type="text" class="jt-mv-search" placeholder="e.g. 7010 or Smith" autocomplete="off" />
          <div class="jt-mv-results" style="margin-top:6px;"></div>
          <div class="jt-mv-stages" style="margin-top:6px;"></div>
        </div>
        <div style="margin-top:12px;">
          <button type="button" class="jt-mv-save" disabled>Move</button>
          <button type="button" class="secondary jt-mv-cancel">Cancel</button>
        </div>
        <div class="jt-mv-msg"></div>
      </div>`;
    const $ = (sel) => panel.querySelector(sel);
    let target = null;
    let timer = null;
    const canSave = () => {
      const cat = $('.jt-mv-cat').value;
      $('.jt-mv-save').disabled = cat === 'job' ? !(target && panel.querySelectorAll('.jt-mv-stage:checked').length) : false;
    };
    $('.jt-mv-cancel').addEventListener('click', () => { panel.innerHTML = ''; });
    $('.jt-mv-cat').addEventListener('change', () => { $('.jt-mv-job').style.display = $('.jt-mv-cat').value === 'job' ? '' : 'none'; canSave(); });
    $('.jt-mv-search').addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = $('.jt-mv-search').value.trim().replace(/^j/i, '');
        const out = $('.jt-mv-results');
        if (q.length < 2) { out.innerHTML = ''; return; }
        const safe = q.replace(/[%,()]/g, ' ');
        let query = supabaseClient.from('projects').select('id, name, job_number, client_name, status').not('job_number', 'is', null).neq('id', S.project.id).limit(8).order('job_number', { ascending: false });
        query = /^\d+$/.test(q) ? query.eq('job_number', Number(q)) : query.or(`name.ilike.%${safe}%,client_name.ilike.%${safe}%`);
        const { data, error } = await query;
        if (error) { out.innerHTML = `<div class="error-box">${esc(friendlyError(error))}</div>`; return; }
        out.innerHTML = (data || []).length ? data.map((p) => `
          <button type="button" class="secondary jt-mv-pick" data-id="${esc(p.id)}" style="display:block; width:100%; text-align:left; margin-top:4px; font-size:13px;">
            ${esc(jobRef(p))}${p.client_name ? ` <span class="subtitle">&middot; ${esc(p.client_name)}</span>` : ''}${p.status === 'archived' ? ' <span class="subtitle">(archived)</span>' : ''}
          </button>`).join('') : '<p class="subtitle">No job found.</p>';
        out.querySelectorAll('.jt-mv-pick').forEach((b) => b.addEventListener('click', async () => {
          const p = data.find((x) => x.id === b.dataset.id);
          const { data: cc, error: ccErr } = await supabaseClient.from('cost_centres').select('id, name, sort_order').eq('project_id', p.id).order('sort_order');
          if (ccErr) { $('.jt-mv-stages').innerHTML = `<div class="error-box">${esc(friendlyError(ccErr))}</div>`; return; }
          target = p;
          out.innerHTML = `<p style="margin:4px 0;">Moving to <b>${esc(jobRef(p))}</b> <a href="#" class="link-quiet jt-mv-change">change</a></p>`;
          out.querySelector('.jt-mv-change').addEventListener('click', (ev) => { ev.preventDefault(); target = null; out.innerHTML = ''; $('.jt-mv-stages').innerHTML = ''; $('.jt-mv-search').value = ''; $('.jt-mv-search').focus(); canSave(); });
          $('.jt-mv-stages').innerHTML = (cc || []).length ? `<label>Stage(s) on ${esc(p.job_number ? 'J' + p.job_number : 'that job')}</label>` + cc.map((c) => `
            <label style="display:flex; align-items:center; gap:8px; font-weight:400; margin-top:6px;">
              <input type="checkbox" class="jt-mv-stage" value="${esc(c.id)}" style="width:auto;" ${cc.length === 1 ? 'checked' : ''} /> ${esc(c.name)}
            </label>`).join('') : '<p class="subtitle">That job has no stages yet. Add one on that job first.</p>';
          panel.querySelectorAll('.jt-mv-stage').forEach((x) => x.addEventListener('change', canSave));
          canSave();
        }));
      }, 250);
    });
    $('.jt-mv-save').addEventListener('click', async () => {
      const cat = $('.jt-mv-cat').value;
      const btn = $('.jt-mv-save');
      btn.disabled = true; btn.textContent = 'Moving...';
      try {
        await call({
          action: 'move', entryIds: ids, time_category: cat,
          project_id: cat === 'job' && target ? target.id : null,
          stage_ids: cat === 'job' ? [...panel.querySelectorAll('.jt-mv-stage:checked')].map((x) => x.value) : [],
        });
        if (typeof showToast === 'function') showToast(`Moved ${ids.length} shift${ids.length === 1 ? '' : 's'} to ${cat === 'job' && target ? jobRef(target) : timeCategoryLabel(cat)}.`);
        await afterChange();
      } catch (err) {
        $('.jt-mv-msg').innerHTML = `<div class="error-box">${esc(friendlyError(err))}</div>`;
        btn.disabled = false; btn.textContent = 'Move';
      }
    });
    $('.jt-mv-search').focus();
  }

  // ---------- fix one shift: stage or category; ServiceM8 times or delete ----------
  function openEditRow(entry) {
    const cell = document.querySelector(`.jt-edit[data-edit-for="${entry.id}"]`);
    if (!cell) return;
    const selectedIds = entry.selected_cost_centre_ids && entry.selected_cost_centre_ids.length ? entry.selected_cost_centre_ids : (entry.cost_centre_id ? [entry.cost_centre_id] : []);
    const category = entry.time_category && entry.time_category !== 'job' ? entry.time_category : 'job';
    // ServiceM8 imports can be wrong in ServiceM8 itself: Admin can fix the times or delete them (Sydney
    // times). Our own staff's times are edited in Timesheets, where the Xero lock applies.
    const isSm8 = !!entry.sm8_activity_uuid;
    const sydParts = (iso) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: SYD, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
      return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
    };
    const sydToIso = (dateKey, time) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !/^\d{2}:\d{2}$/.test(time)) return null;
      const naive = new Date(`${dateKey}T${time}:00Z`).getTime();
      const guess = naive - sydneyOffsetMinutesAt(new Date(naive)) * 60000;
      return new Date(naive - sydneyOffsetMinutesAt(new Date(guess)) * 60000).toISOString();
    };
    const inP = isSm8 ? sydParts(entry.clock_in) : null;
    const outP = isSm8 && entry.clock_out ? sydParts(entry.clock_out) : { date: inP ? inP.date : '', time: '' };
    cell.innerHTML = `
      <div style="padding:10px; background:var(--surface-2); border-radius:8px; margin-top:8px;">
        ${isSm8 ? `
        <p class="subtitle" style="margin:0 0 6px;">ServiceM8 check-in. Fix the times if they are wrong in ServiceM8, or delete it. A new ServiceM8 import will not undo either.</p>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
          <div><label style="margin-top:0;">Start date</label><input type="date" class="jt-in-date" value="${inP.date}" /></div>
          <div><label style="margin-top:0;">Start time</label><input type="time" class="jt-in-time" value="${inP.time}" /></div>
          <div><label>Finish date</label><input type="date" class="jt-out-date" value="${outP.date}" /></div>
          <div><label>Finish time</label><input type="time" class="jt-out-time" value="${outP.time}" /></div>
        </div>` : ''}
        <label style="${isSm8 ? '' : 'margin-top:0;'}">Category</label>
        <select class="jt-category">
          <option value="job" ${category === 'job' ? 'selected' : ''}>Job - split across stage(s) below</option>
          ${timeCategoryOptionsHtml(category)}
        </select>
        <div class="jt-stage-section" style="margin-top:8px; ${category === 'job' ? '' : 'display:none;'}">
          <label>Stage(s) - tick every stage this shift's hours count against</label>
          ${centres().map((c) => `
            <label style="display:flex; align-items:center; gap:8px; font-weight:400; margin-top:6px;">
              <input type="checkbox" class="jt-stage-check" value="${esc(c.id)}" style="width:auto;" ${selectedIds.includes(c.id) ? 'checked' : ''} /> ${esc(c.name)}
            </label>`).join('')}
        </div>
        <p class="subtitle" style="margin:8px 0 0;">Wrong job altogether? Tick it and use Move.</p>
        <div style="margin-top:12px;">
          <button type="button" class="jt-save-btn">Save</button>
          <button type="button" class="secondary jt-cancel-btn">Cancel</button>
          ${isSm8 ? '<button type="button" class="secondary jt-delete-btn" style="color:var(--red);">Delete</button>' : ''}
        </div>
        <div class="jt-edit-msg"></div>
      </div>`;
    const $ = (sel) => cell.querySelector(sel);
    $('.jt-category').addEventListener('change', (e) => { $('.jt-stage-section').style.display = e.target.value === 'job' ? '' : 'none'; });
    $('.jt-cancel-btn').addEventListener('click', () => { cell.innerHTML = ''; });
    $('.jt-save-btn').addEventListener('click', async () => {
      const msg = $('.jt-edit-msg');
      const cat = $('.jt-category').value;
      const ids = [...cell.querySelectorAll('.jt-stage-check:checked')].map((el) => el.value);
      if (cat === 'job' && !ids.length) { msg.innerHTML = '<div class="error-box">Tick at least one stage, or choose a non-job category.</div>'; return; }
      let times = {};
      if (isSm8) {
        const clockIn = sydToIso($('.jt-in-date').value, $('.jt-in-time').value);
        const clockOut = sydToIso($('.jt-out-date').value, $('.jt-out-time').value);
        if (!clockIn || !clockOut) { msg.innerHTML = '<div class="error-box">Fill in the start and finish date and time.</div>'; return; }
        if (clockOut <= clockIn) { msg.innerHTML = '<div class="error-box">Finish must be after start.</div>'; return; }
        times = { clock_in: clockIn, clock_out: clockOut };
      }
      try {
        await call({
          ...times, entryId: entry.id, time_category: cat,
          project_id: cat === 'job' ? S.project.id : null,
          cost_centre_id: cat === 'job' && ids.length === 1 ? ids[0] : null,
          selected_cost_centre_ids: cat === 'job' && ids.length > 1 ? ids : null,
        });
        await afterChange();
      } catch (err) { msg.innerHTML = `<div class="error-box">${esc(friendlyError(err))}</div>`; }
    });
    const del = $('.jt-delete-btn');
    if (del) del.addEventListener('click', async () => {
      const h = hoursOf(entry);
      if (!confirm(`Delete this ServiceM8 shift for ${entry.profiles?.full_name || 'this person'}${h === null ? '' : ` (${h.toFixed(2)} hours)`}? It comes off this job's labour cost and a new ServiceM8 import will not bring it back.`)) return;
      try { await call({ entryId: entry.id, delete: true }); await afterChange(); } catch (err) { $('.jt-edit-msg').innerHTML = `<div class="error-box">${esc(friendlyError(err))}</div>`; }
    });
  }

  // ---------- the Summary "accrued cost" figure: received PO materials, and a way to the Time tab ----------
  async function openAccruedCost(project, pricingVisible) {
    const centres = (project.cost_centres || []).slice().sort((a, b) => a.sort_order - b.sort_order);
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px;';
    overlay.innerHTML = `
      <div class="card" style="max-width:720px; width:100%; max-height:85vh; overflow-y:auto;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <h2 style="margin:0;">Accrued cost on this job</h2>
          <button type="button" class="secondary" id="td-close-btn">Close</button>
        </div>
        <h3 style="margin-bottom:8px;">Labour</h3>
        <p class="subtitle" style="margin:0 0 6px;">Every shift, who worked it and its cost are on the Time tab, where Admin can also move shifts that belong on another job.</p>
        <button type="button" id="td-time-btn" style="font-size:12px; padding:6px 12px;">Open the Time tab</button>
        <h3 style="margin:22px 0 8px;">Purchase orders received</h3>
        <div id="td-po-list"><p class="subtitle">Loading...</p></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#td-close-btn').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#td-time-btn').addEventListener('click', () => {
      overlay.remove();
      const tab = document.querySelector('#job-tabs .settings-tab[data-panel="time"]');
      if (tab) { tab.click(); tab.scrollIntoView({ block: 'nearest' }); }
    });

    const centreName = (id) => centres.find(c => c.id === id)?.name || 'Unknown stage';

    async function refreshPoList() {
      const listEl = overlay.querySelector('#td-po-list');
      if (!pricingVisible) { listEl.innerHTML = `<p class="subtitle">Pricing details are hidden for your role.</p>`; return; }

      const { data: pos, error } = await supabaseClient
        .from('purchase_orders')
        .select('id, po_number, cost_centre_id, suppliers(name), supplier_name, purchase_order_line_items(description, quantity, unit_cost, received)')
        .eq('project_id', project.id);
      if (error) { listEl.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(error))}</div>`; return; }

      const receivedRows = [];
      (pos || []).forEach(po => {
        const supplierLabel = po.suppliers?.name || po.supplier_name || 'Unknown supplier';
        (po.purchase_order_line_items || []).filter(li => li.received).forEach(li => {
          receivedRows.push({ ...li, supplierLabel, poNumber: po.po_number, stage: centreName(po.cost_centre_id) });
        });
      });

      if (!receivedRows.length) { listEl.innerHTML = `<p class="subtitle">No purchase order line items received yet - only received items count as accrued cost, not just approved/ordered ones.</p>`; return; }

      const totalMaterial = receivedRows.reduce((s, li) => s + Number(li.quantity) * Number(li.unit_cost), 0);
      listEl.innerHTML = `
        <table class="responsive-stack">
          <thead><tr><th>Item</th><th>Supplier</th><th>Stage</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Total</th></tr></thead>
          <tbody>
            ${receivedRows.map(li => `
              <tr>
                <td data-label="Item">${escapeHtml(li.description)}${li.poNumber ? ` <span class="subtitle" style="font-size:11px;">(${escapeHtml(li.poNumber)})</span>` : ''}</td>
                <td data-label="Supplier">${escapeHtml(li.supplierLabel)}</td>
                <td data-label="Stage">${escapeHtml(li.stage)}</td>
                <td class="num" data-label="Qty">${li.quantity}</td>
                <td class="num" data-label="Unit cost">${money(li.unit_cost)}</td>
                <td class="num" data-label="Total">${money(Number(li.quantity) * Number(li.unit_cost))}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr><td colspan="5" style="text-align:right; font-weight:600;">Total received materials cost</td><td class="num" style="font-weight:600;">${money(totalMaterial)}</td></tr></tfoot>
        </table>`;
    }

    await refreshPoList();
  }

  window.initJobTime = initJobTime;
  window.openAccruedCost = openAccruedCost;
  window.loadJobTime = loadJobTime;
})();
