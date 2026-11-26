// The Plan view on the Schedule page (backlog item 92): a Gantt chart of every job with site
// work ahead and every sent quote. Loaded by schedule.html when Plan is picked; the maths is
// js/plan-calc.js. Staff see it read only. Admin, Finance and Sales drag a bar to move it, drag
// its right edge to stretch it, and tell the client the dates (plan-email.js). An Admin sets the
// numbers the plan runs on and who is on the tools.
// Reads job_windows, projects, schedule_assignments, purchase_orders, profiles, leave_requests,
// public_holidays, company_settings. Writes job_windows (dates and sizes), and for an Admin
// company_settings.plan_* and profiles.on_tools.

const PlanChart = (() => {
  const P = PlanCalc;
  const esc = (s) => escapeHtml(s);
  const LABEL_W = 250;
  const WEEKS = 12;
  const S = { el: null, canEdit: false, isAdmin: false, myId: null, start: null, focus: null, data: null, onLabel: null };
  const today = () => sydneyDateKey(new Date());
  const mondayOf = (ymd) => { const dow = new Date(ymd + 'T00:00:00Z').getUTCDay(); return P.addDays(ymd, dow === 0 ? -6 : 1 - dow); };
  const ref = (p) => (p.job_number ? `J${p.job_number}` : `Q${p.quote_number || ''}`);
  const isPhone = () => window.innerWidth < 900;
  const daysText = (n) => `${Number(n)} day${Number(n) === 1 ? '' : 's'}`;

  async function call(body) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const res = await fetch('/.netlify/functions/plan-email', {
      method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Failed (${res.status})`);
    return data;
  }

  // ---------- data ----------
  async function load() {
    const from = P.addDays(today(), -60);
    const q = (p) => p.then(({ data, error }) => { if (error) throw error; return data || []; });
    const W = 'job_windows';
    const WCOLS = '*, projects!inner(id, name, job_number, quote_number, client_name, pipeline_stage, status, sent_at, expired), cost_centres(name)';
    const [settings, holidays, people, leave, jobWins, quoteWins, focusWins] = await Promise.all([
      q(supabaseClient.from('company_settings').select('plan_day_hours, plan_crew_size, plan_lead_weeks, plan_slip_days').eq('id', 1)),
      q(supabaseClient.from('public_holidays').select('holiday_date').gte('holiday_date', from)),
      q(supabaseClient.from('profiles').select('id, full_name, role, on_tools').eq('active', true).order('full_name')),
      q(supabaseClient.from('leave_requests').select('staff_id, start_date, end_date').eq('status', 'approved').is('hours', null).gte('end_date', from)),
      // only the rows the plan draws (a request returns at most 1,000 rows, and every quote opened
      // keeps one): jobs with site work ahead, sent quotes, and the job or quote it was opened on
      q(supabaseClient.from(W).select(WCOLS).not('projects.job_number', 'is', null).in('projects.pipeline_stage', P.ACTIVE_STAGES)),
      q(supabaseClient.from(W).select(WCOLS).is('projects.job_number', null).eq('projects.status', 'sent').eq('projects.expired', false)),
      S.focus ? q(supabaseClient.from(W).select(WCOLS).eq('project_id', S.focus)) : Promise.resolve([]),
    ]);
    const seen = new Set();
    const windows = [...jobWins, ...quoteWins, ...focusWins].filter((w) => !seen.has(w.id) && seen.add(w.id));
    const s = settings[0] || {};
    const live = windows.filter((w) => {
      const p = w.projects;
      if (p.job_number) return P.ACTIVE_STAGES.includes(p.pipeline_stage);
      return (p.status === 'sent' && !p.expired) || p.id === S.focus;
    });
    const jobIds = [...new Set(live.filter((w) => w.projects.job_number).map((w) => w.project_id))];
    const [bookings, pos, asks] = jobIds.length ? await Promise.all([
      q(supabaseClient.from('schedule_assignments').select('project_id, assignment_date, client_informed_at').in('project_id', jobIds).eq('block_type', 'job')),
      q(supabaseClient.from('purchase_orders').select('project_id, received').in('project_id', jobIds)),
      // a client's open ask for a date from the portal (item 74 point 9a)
      q(supabaseClient.from('portal_booking_requests').select('project_id, ask_date, ask_time').in('project_id', jobIds).is('answered_at', null).is('withdrawn_at', null)),
    ]) : [[], [], []];
    const ctx = { holidays: new Set(holidays.map((h) => h.holiday_date)), crew: people.filter(P.onTools).map((p) => p.id), leave };
    const settingsOut = { dayHours: Number(s.plan_day_hours) || 8, crew: Number(s.plan_crew_size) || 2, leadWeeks: s.plan_lead_weeks == null ? 2 : Number(s.plan_lead_weeks), slipDays: s.plan_slip_days == null ? 2 : Number(s.plan_slip_days) };

    // one entry per job or quote: its own window, its variations, bookings and orders
    const byProject = new Map();
    for (const w of live) {
      const g = byProject.get(w.project_id) || { project: w.projects, isJob: !!w.projects.job_number, main: null, variations: [] };
      if (w.cost_centre_id) g.variations.push(w); else g.main = w;
      byProject.set(w.project_id, g);
    }
    // every job with site work ahead is on the plan, even one made without a quote (a direct job, a job
    // from a lead, a portal book-in): with no plan row yet it sits in No dates yet until it is placed
    const activeJobs = await q(supabaseClient.from('projects').select('id, name, job_number, quote_number, client_name, pipeline_stage, status').not('job_number', 'is', null).in('pipeline_stage', P.ACTIVE_STAGES));
    for (const p of activeJobs) {
      const g = byProject.get(p.id);
      if (g && g.main) continue;
      byProject.set(p.id, { project: p, isJob: true, variations: (g && g.variations) || [], main: { id: null, virtual: true, project_id: p.id, cost_centre_id: null, onsite_days: 1, crew_size: settingsOut.crew, lead_weeks: 0, start_date: null, end_date: null } });
    }
    const items = [...byProject.values()].filter((g) => g.main);
    const jobs = items.filter((g) => g.isJob);
    const load = P.buildLoad(jobs.flatMap((g) => [g.main, ...g.variations]), ctx.holidays);
    const t = today();
    for (const g of items) {
      g.rows = [g.main, ...g.variations];
      if (g.isJob) {
        g.span = P.jobSpan(g.rows);
        g.slip = P.slipFor(g.main, g.rows, settingsOut.slipDays, ctx.holidays);
        g.bookedDays = g.main.virtual ? [] : [...new Set(bookings.filter((b) => b.project_id === g.project.id).map((b) => b.assignment_date))].sort();
        const orders = pos.filter((o) => o.project_id === g.project.id);
        g.ask = asks.find((a) => a.project_id === g.project.id) || null;
        g.po = !orders.length ? 'none' : orders.every((o) => o.received) ? 'received' : 'ordered';
        g.orderBy = g.span && Number(g.main.lead_weeks) > 0 ? P.addDays(g.span.start, -Number(g.main.lead_weeks) * 7) : null;
        g.notBooked = !!g.span && g.span.start >= t && P.daysBetween(t, g.span.start) <= 14 && !g.bookedDays.some((d) => d >= g.span.start && d <= g.span.end);
      } else {
        // a quote sits where it would land if the client said yes today
        const gap = P.firstGap({ days: g.main.onsite_days, crew: g.main.crew_size, earliest: P.addDays(t, Number(g.main.lead_weeks) * 7), load, ctx });
        g.span = { start: gap.start, end: gap.end };
        g.wait = P.waitRange(t, gap.start);
      }
    }
    jobs.sort((a, b) => ((a.span && a.span.start) || '9').localeCompare((b.span && b.span.start) || '9') || ref(a.project).localeCompare(ref(b.project), undefined, { numeric: true }));
    const quotes = items.filter((g) => !g.isJob).sort((a, b) => a.span.start.localeCompare(b.span.start));
    S.data = { settings: settingsOut, ctx, people, load, jobs, quotes, today: t };
  }

  const find = (projectId) => [...S.data.jobs, ...S.data.quotes].find((g) => g.project.id === projectId);

  // ---------- writes ----------
  async function saveWindow(id, patch) {
    const { error } = await supabaseClient.from('job_windows').update({ ...patch, updated_by: S.myId, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
  }

  // A job with no plan row gets one, its days on site from the labour hours on its stages (as a quote's
  // When card works them out), the usual crew, and no gear lead time (it is already a job).
  async function ensureWindow(g) {
    if (!g.main.virtual) return g.main;
    const { data: centres } = await supabaseClient.from('cost_centres').select('cost_centre_line_items(item_type, quantity)').eq('project_id', g.project.id);
    const hours = (centres || []).reduce((sum, c) => sum + (c.cost_centre_line_items || []).filter((li) => li.item_type === 'labour').reduce((h, li) => h + (Number(li.quantity) || 0), 0), 0);
    const days = P.daysFromHours(hours, S.data.settings.crew, S.data.settings.dayHours);
    const { data, error } = await supabaseClient.from('job_windows').insert({ project_id: g.project.id, onsite_days: days, crew_size: S.data.settings.crew, lead_weeks: 0, updated_by: S.myId }).select('*').single();
    if (error) throw error;
    g.main = data;
    g.rows = [data, ...g.variations];
    return data;
  }

  // Put a job with no dates in the first gap that fits; its undated variations follow it.
  async function placeInFirstGap(g) {
    await ensureWindow(g);
    const { ctx, load, today: t } = S.data;
    const gap = P.firstGap({ days: g.main.onsite_days, crew: g.main.crew_size, earliest: P.addDays(t, Number(g.main.lead_weeks) * 7), load, ctx });
    await saveWindow(g.main.id, { start_date: gap.start, end_date: gap.end });
    let after = gap.end;
    for (const v of g.variations.filter((w) => !w.start_date)) {
      const from = P.nextWorkDay(P.addDays(after, 1), ctx.holidays);
      after = P.endAfterWorkDays(from, v.onsite_days, ctx.holidays);
      await saveWindow(v.id, { start_date: from, end_date: after });
    }
    return gap;
  }

  // ---------- drawing ----------
  function statusChip(g) {
    if (!g.isJob) return `<span class="plan-chip">Tell the client: ${esc(g.wait.text)}</span>`;
    if (!g.span) return '<span class="plan-chip warn">No dates yet</span>';
    if (g.slip) return '<span class="plan-chip bad">Client not told of the change</span>';
    if (g.main.promised_start) return '<span class="plan-chip ok">Client confirmed</span>';
    return '<span class="plan-chip warn">Confirm dates with client</span>';
  }
  const poChip = (g) => (g.po === 'received' ? '<span class="plan-chip ok">Gear received</span>' : g.po === 'ordered' ? '<span class="plan-chip">Gear ordered</span>' : Number(g.main.lead_weeks) > 0 ? `<span class="plan-chip ${g.orderBy && g.orderBy <= P.addDays(S.data.today, 7) ? 'bad' : ''}">Nothing ordered${g.orderBy ? `, order by ${esc(P.fmtDay(g.orderBy))}` : ''}</span>` : '');
  const askChip = (g) => (g.ask ? `<span class="plan-chip warn">Client asked for ${esc(P.fmtDay(g.ask.ask_date))}${g.ask.ask_time ? `, ${esc(String(g.ask.ask_time).slice(0, 5))}` : ''}</span>` : '');
  const flagsHtml = (g) => `${statusChip(g)}${g.isJob ? askChip(g) : ''}${g.isJob && g.span ? `${poChip(g)}${g.notBooked ? '<span class="plan-chip bad">Nobody booked</span>' : ''}` : ''}`;

  function weekLoads(weeksFrom, count) {
    const { load, ctx } = S.data;
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const mon = P.addDays(weeksFrom, i * 7);
      const days = P.workDaysIn(mon, P.addDays(mon, 6), ctx.holidays);
      const planned = days.reduce((sum, d) => sum + (load.get(d) || 0), 0);
      const free = days.reduce((sum, d) => sum + P.capacityOn(d, ctx), 0);
      const pct = free ? planned / free : planned ? 2 : 0;
      out.push({ mon, planned: Math.round(planned * 10) / 10, free, tone: pct > 1 ? 'bad' : pct >= 0.7 ? 'warn' : 'ok' });
    }
    return out;
  }

  function render() {
    const d = S.data;
    const end = P.addDays(S.start, WEEKS * 7 - 1);
    if (S.onLabel) S.onLabel(`${P.fmtDay(S.start).replace(/^\S+ /, '')} to ${P.fmtDay(end).replace(/^\S+ /, '')} ${end.slice(0, 4)}`, S.start);
    // the search box: job or quote number, job name or client, as you type
    const words = String(S.q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (g) => !words.length || words.every((w) => `${ref(g.project)} ${g.project.name || ''} ${g.project.client_name || ''}`.toLowerCase().includes(w));
    const undated = d.jobs.filter((g) => !g.span && hit(g));
    const dated = d.jobs.filter((g) => g.span && hit(g));
    const quotesShown = d.quotes.filter(hit);
    const head = `
      <div class="plan-top">
        <input type="search" id="plan-search" placeholder="Find a job: number, name or client" value="${esc(S.q || '')}" style="width:260px; max-width:100%; font-size:13px; padding:5px 10px;" />
        ${words.length ? `<span class="plan-muted">${dated.length + undated.length + quotesShown.length} found${!dated.length && !undated.length && !quotesShown.length ? '. Only jobs with site work ahead (Quote approved to Job not complete) are on the plan: move a job back on the Job Pipeline to bring it here.' : ''}</span>` : ''}
        <span class="plan-key"><i class="plan-sw job"></i>Job <i class="plan-sw var"></i>Variation <i class="plan-sw quote"></i>Quote, if approved today <i class="plan-sw booked"></i>People booked <i class="plan-sw slip"></i>Client not told</span>
        <span style="flex:1"></span>
        ${d.ctx.crew.length ? `<span class="plan-muted">${d.ctx.crew.length} on the tools</span>` : '<span class="plan-chip warn">Nobody is ticked as on the tools, so the load is not measured</span>'}
        ${S.isAdmin ? '<button type="button" class="secondary btn-sm" id="plan-settings">Plan settings</button>' : ''}
      </div>
      ${undated.length ? `<details class="plan-undated" ${S.undatedOpen || words.length ? 'open' : ''}><summary><strong>No dates yet (${undated.length})</strong> <span class="plan-muted">${S.canEdit ? 'tap one to put it in the first gap that fits' : ''}</span></summary><div class="plan-undated-list">${undated.map((g) => `<button type="button" class="secondary btn-sm" data-undated="${esc(g.project.id)}" title="${S.canEdit ? 'Put it in the first gap that fits' : ''}">${esc(ref(g.project))} ${esc(g.project.name)}, ${esc(daysText(g.main.onsite_days))}</button>`).join('')}</div></details>` : ''}`;
    S.el.innerHTML = head + (isPhone() ? listHtml(dated, quotesShown) : chartHtml(dated, quotesShown)) + (!dated.length && !d.quotes.length && !undated.length ? '<p class="subtitle" style="padding:16px;">Nothing on the plan yet. A job appears here when its quote is approved, and a quote when it is sent.</p>' : '');
    wire();
    if (S.focus) {
      const row = S.el.querySelector(`[data-row="${S.focus}"]`);
      if (row) { row.classList.add('focus'); row.scrollIntoView({ block: 'center' }); }
    }
  }

  function chartHtml(jobs, quotes) {
    const d = S.data;
    const width = Math.max(600, S.el.clientWidth - LABEL_W - 2);
    const dayW = width / (WEEKS * 7);
    S.dayW = dayW;
    const x = (ymd) => P.daysBetween(S.start, ymd) * dayW;
    const inView = (a, b) => b >= S.start && a <= P.addDays(S.start, WEEKS * 7 - 1);
    const weeks = weekLoads(S.start, WEEKS);
    const weekCells = weeks.map((w, i) => `<div class="plan-week" style="left:${i * 7 * dayW}px; width:${7 * dayW}px;"><span>${esc(P.fmtDay(w.mon).replace(/^\S+ /, ''))}</span></div>`).join('');
    const loadCells = weeks.map((w, i) => `<div class="plan-load ${w.tone}" style="left:${i * 7 * dayW}px; width:${7 * dayW}px;" title="${w.planned} person days planned of ${w.free} free">${w.planned}/${w.free}</div>`).join('');
    // weekends and public holidays shaded, today as a line
    let shade = '';
    for (let i = 0; i < WEEKS * 7; i += 1) {
      const day = P.addDays(S.start, i);
      if (!P.isWorkDay(day, d.ctx.holidays)) shade += `<div class="plan-off" style="left:${i * dayW}px; width:${dayW}px;"></div>`;
    }
    const todayLine = d.today >= S.start && d.today <= P.addDays(S.start, WEEKS * 7 - 1) ? `<div class="plan-today" style="left:${x(d.today) + dayW / 2}px;"></div>` : '';
    const bar = (w, cls, label, g) => {
      if (!w.start_date || !inView(w.start_date, w.end_date)) return '';
      const left = Math.max(0, x(w.start_date));
      const right = Math.min(width, x(w.end_date) + dayW);
      const ticks = (g.bookedDays || []).filter((day) => day >= w.start_date && day <= w.end_date && day >= S.start).map((day) => `<i class="plan-booked" style="left:${x(day) - left}px; width:${dayW}px;"></i>`).join('');
      const narrow = right - left < 90 ? ' narrow' : '';
      return `<div class="plan-bar ${cls}${narrow}" data-window="${esc(w.id)}" data-project="${esc(g.project.id)}" style="left:${left}px; width:${Math.max(dayW, right - left)}px;" title="${esc(label)}: ${esc(P.fmtRange(w.start_date, w.end_date))}, ${esc(daysText(w.onsite_days))} on site, crew of ${Number(w.crew_size)}">${ticks}<span>${esc(label)}</span>${S.canEdit && g.isJob ? '<b class="plan-grip"></b>' : ''}</div>`;
    };
    const rowHtml = (g) => {
      const p = g.project;
      const main = g.isJob ? g.main : { ...g.main, start_date: g.span.start, end_date: g.span.end };
      const orderMark = g.isJob && g.orderBy && g.po === 'none' && g.orderBy >= S.start && g.orderBy <= P.addDays(S.start, WEEKS * 7 - 1) ? `<div class="plan-order" style="left:${x(g.orderBy)}px;" title="Order gear by ${esc(P.fmtDay(g.orderBy))}"></div>` : '';
      const variations = g.variations.map((v) => bar(v, 'var', (v.cost_centres && v.cost_centres.name) || 'Variation', g)).join('');
      return `
        <div class="plan-row ${g.variations.length ? 'two' : ''}" data-row="${esc(p.id)}">
          <div class="plan-label" data-open="${esc(p.id)}">
            <div class="plan-name"><strong>${esc(ref(p))}</strong> ${esc(p.name)}</div>
            <div class="plan-flags">${flagsHtml(g)}</div>
          </div>
          <div class="plan-lane" style="width:${width}px;">
            ${orderMark}
            ${bar(main, g.isJob ? `job ${g.slip ? 'slip' : ''}` : 'quote', `${ref(p)} ${daysText(g.main.onsite_days)}`, g)}
            ${variations ? `<div class="plan-sub">${variations}</div>` : ''}
          </div>
        </div>`;
    };
    return `
      <div class="plan-scroll">
        <div class="plan-head">
          <div class="plan-label plan-muted">Week starting<br>Crew load (person days)</div>
          <div class="plan-lane" style="width:${width}px; height:44px;">${weekCells}${loadCells}</div>
        </div>
        <div class="plan-body" style="--plan-w:${width}px;">
          <div class="plan-backdrop" style="left:${LABEL_W}px; width:${width}px;">${shade}${todayLine}</div>
          ${jobs.map(rowHtml).join('')}
          ${quotes.length ? `<div class="plan-divider">Quotes sent, shown where each would land if approved today (not counted in the load)</div>${quotes.map(rowHtml).join('')}` : ''}
        </div>
      </div>`;
  }

  // A phone: the same plan as a list by week.
  function listHtml(jobs, quotes) {
    const weeks = weekLoads(mondayOf(S.start), WEEKS);
    const line = (g) => `
      <div class="plan-card" data-row="${esc(g.project.id)}" data-open="${esc(g.project.id)}">
        <div><strong>${esc(ref(g.project))}</strong> ${esc(g.project.name)}</div>
        <div class="plan-muted">${esc(P.fmtRange(g.span.start, g.span.end))}, ${esc(daysText(g.rows.reduce((sum, w) => sum + Number(w.onsite_days), 0)))} on site${g.variations.length ? `, ${g.variations.length} variation${g.variations.length === 1 ? '' : 's'}` : ''}</div>
        <div class="plan-flags">${flagsHtml(g)}</div>
      </div>`;
    // only the weeks with work in them (a job shows in the week it starts), so the list stays short
    const body = weeks.map((w) => {
      const end = P.addDays(w.mon, 6);
      const here = jobs.filter((g) => g.span.start <= end && g.span.start >= w.mon || (w === weeks[0] && g.span.start < w.mon && g.span.end >= w.mon));
      return here.length ? `<div class="plan-weekhead"><span>Week of ${esc(P.fmtDay(w.mon))}</span><span class="plan-chip ${w.tone}">${w.planned}/${w.free} person days</span></div>${here.map(line).join('')}` : '';
    }).join('') || '<p class="plan-muted">Nothing planned in these 12 weeks.</p>';
    return `<div class="plan-list">${body}${quotes.length ? `<div class="plan-weekhead"><span>Quotes sent, if approved today</span></div>${quotes.map(line).join('')}` : ''}</div>`;
  }

  // ---------- drag to move, drag the right edge to stretch ----------
  function wireDrag(barEl) {
    const g = find(barEl.dataset.project);
    const w = g && g.rows.find((r) => r.id === barEl.dataset.window);
    if (!w) return;
    let startX = 0, mode = null, moved = 0;
    const leftPx = parseFloat(barEl.style.left), widthPx = parseFloat(barEl.style.width);
    const onMove = (e) => {
      moved = Math.round((e.clientX - startX) / S.dayW);
      if (mode === 'move') barEl.style.left = `${leftPx + moved * S.dayW}px`;
      else barEl.style.width = `${Math.max(S.dayW, widthPx + moved * S.dayW)}px`;
    };
    const onUp = async () => {
      barEl.removeEventListener('pointermove', onMove);
      barEl.removeEventListener('pointerup', onUp);
      barEl.removeEventListener('pointercancel', onUp);
      if (!moved) { openDetail(g.project.id); return; }
      const { holidays } = S.data.ctx;
      let patch;
      if (mode === 'move') {
        // the same number of working days, so a move never ends on a weekend or holiday
        const start = P.nextWorkDay(P.addDays(w.start_date, moved), holidays);
        patch = { start_date: start, end_date: P.endAfterWorkDays(start, Math.max(1, P.workDaysIn(w.start_date, w.end_date, holidays).length), holidays) };
      } else {
        const end = P.addDays(w.end_date, moved) < w.start_date ? w.start_date : P.addDays(w.end_date, moved);
        patch = { end_date: end };
        // a window squeezed below its on-site days: the days come down to what fits
        const fits = P.workDaysIn(w.start_date, end, holidays).length;
        if (fits && fits < Number(w.onsite_days)) patch.onsite_days = fits;
      }
      try {
        await saveWindow(w.id, patch);
        // moving the job moves its variations by the same number of days, so they stay after it
        if (mode === 'move' && !w.cost_centre_id) {
          const shiftBy = P.daysBetween(w.start_date, patch.start_date);
          for (const v of g.variations.filter((x) => x.start_date)) {
            const vs = P.nextWorkDay(P.addDays(v.start_date, shiftBy), holidays);
            await saveWindow(v.id, { start_date: vs, end_date: P.endAfterWorkDays(vs, Math.max(1, P.workDaysIn(v.start_date, v.end_date, holidays).length), holidays) });
          }
        }
        await refresh();
        const now = find(g.project.id);
        if (now && now.slip) openDetail(g.project.id); // the client was told other dates: tell them now
      } catch (err) { showToast(err.message, { error: true }); await refresh(); }
    };
    barEl.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      e.preventDefault();
      startX = e.clientX; moved = 0;
      mode = e.target.classList.contains('plan-grip') ? 'stretch' : 'move';
      barEl.setPointerCapture(e.pointerId);
      barEl.addEventListener('pointermove', onMove);
      barEl.addEventListener('pointerup', onUp);
      barEl.addEventListener('pointercancel', onUp);
    });
  }

  function wire() {
    S.el.querySelectorAll('[data-open]').forEach((n) => n.addEventListener('click', () => openDetail(n.dataset.open)));
    S.el.querySelectorAll('.plan-bar').forEach((n) => {
      const g = find(n.dataset.project);
      if (S.canEdit && g && g.isJob) wireDrag(n); else n.addEventListener('click', () => openDetail(n.dataset.project));
    });
    S.el.querySelectorAll('[data-undated]').forEach((n) => n.addEventListener('click', async () => {
      const g = find(n.dataset.undated);
      if (!S.canEdit) { openDetail(g.project.id); return; }
      n.disabled = true;
      try {
        const gap = await placeInFirstGap(g);
        S.focus = g.project.id;
        if (gap.start < S.start || gap.start > P.addDays(S.start, WEEKS * 7 - 1)) S.start = mondayOf(gap.start);
        await refresh();
        showToast(`${ref(g.project)} planned for ${P.fmtRange(gap.start, gap.end)}. Drag the bar to change it.`);
      } catch (err) { showToast(err.message, { error: true }); n.disabled = false; }
    }));
    // the No dates yet list stays open or folded as the person left it
    const und = S.el.querySelector('.plan-undated');
    if (und) und.addEventListener('toggle', () => { S.undatedOpen = und.open; });
    const search = S.el.querySelector('#plan-search');
    if (search) {
      if (S.searchFocus) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
      let t = null;
      search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { S.q = search.value; S.searchFocus = true; render(); }, 200); });
      search.addEventListener('blur', () => { S.searchFocus = false; });
      // Enter on a single match opens it
      search.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const one = S.el.querySelectorAll('[data-row], [data-undated]');
        if (one.length === 1) { const id = one[0].dataset.row || one[0].dataset.undated; openDetail(id); }
      });
    }
    const settingsBtn = S.el.querySelector('#plan-settings');
    if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
  }

  // ---------- one job or quote ----------
  async function openDetail(projectId) {
    const g = find(projectId);
    if (!g) return;
    // a job with no plan row yet gets one before it can be edited
    if (g.main.virtual && S.canEdit) {
      try { await ensureWindow(g); } catch (err) { showToast(friendlyError(err), { error: true }); return; }
    }
    const p = g.project;
    const d = S.data;
    const edit = S.canEdit && g.isJob;
    const told = g.main.promised_start ? `${g.main.client_confirmed_how === 'phone' ? 'Told by phone' : 'Emailed'} ${esc(P.fmtDay(sydneyDateKey(new Date(g.main.client_confirmed_at))))}: ${esc(P.fmtRange(g.main.promised_start, g.main.promised_end))}` : '';
    const statusHtml = !g.isJob
      ? `<div class="plan-note">If the client approved today this would run <strong>${esc(P.fmtRange(g.span.start, g.span.end))}</strong>. Tell the client: <strong>${esc(g.wait.text)}</strong>.</div>`
      : !g.span ? '<div class="plan-note">No dates yet. Pick a start below, or use First gap.</div>'
      : g.slip ? `<div class="error-box">The job has moved since the client was told. ${told}. Now ${esc(P.fmtRange(g.span.start, g.span.end))}.</div>`
      : g.main.promised_start ? `<div class="plan-note ok">Client confirmed. ${told}.</div>`
      : `<div class="plan-note">Planned for ${esc(P.fmtRange(g.span.start, g.span.end))}. The client has not been told these dates yet.</div>`;
    const rowInputs = (w, label) => `
      <div class="plan-form" data-win="${esc(w.id)}">
        <div class="plan-form-title ${w.cost_centre_id ? 'var' : ''}">${esc(label)}</div>
        <label>Start<input type="date" data-f="start_date" value="${esc(w.start_date || '')}" ${edit ? '' : 'disabled'} /></label>
        <label>Finish<input type="date" data-f="end_date" value="${esc(w.end_date || '')}" ${edit ? '' : 'disabled'} /></label>
        <label>Days on site<input type="number" min="0.5" step="0.5" data-f="onsite_days" value="${Number(w.onsite_days)}" ${edit ? '' : 'disabled'} /></label>
        <label>Crew<input type="number" min="1" max="20" step="1" data-f="crew_size" value="${Number(w.crew_size)}" ${edit ? '' : 'disabled'} /></label>
        ${w.cost_centre_id ? '' : `<label>Gear lead (weeks)<input type="number" min="0" max="52" step="1" data-f="lead_weeks" value="${Number(w.lead_weeks)}" ${edit ? '' : 'disabled'} /></label>`}
      </div>`;
    const overlay = openModal(`
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
        <div><h2 style="margin:0;">${esc(ref(p))} ${esc(p.name)}</h2><p class="subtitle" style="margin:2px 0 8px;">${esc(p.client_name || '')}</p></div>
        <button type="button" class="secondary btn-sm" data-close>Close</button>
      </div>
      ${g.isJob ? `<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        <label style="margin:0; font-size:13px;">Pipeline stage</label>
        <select id="plan-stage" style="width:auto;" ${S.canEdit ? '' : 'disabled'}>${PIPELINE_STAGES.filter((st) => !['lead', 'draft_quote', 'quote_sent'].includes(st.key)).map((st) => `<option value="${esc(st.key)}" ${st.key === p.pipeline_stage ? 'selected' : ''}>${esc(st.label)}</option>`).join('')}</select>
        <span class="plan-muted">From Client handover on, the job leaves the plan.</span>
      </div>` : ''}
      ${statusHtml}
      ${g.isJob ? `<div class="plan-flags" style="margin:8px 0;">${g.span ? poChip(g) : ''}${g.notBooked ? '<span class="plan-chip bad">Nobody booked</span>' : ''}${g.bookedDays.length ? `<span class="plan-chip">${g.bookedDays.length} day${g.bookedDays.length === 1 ? '' : 's'} booked</span>` : ''}</div>` : ''}
      ${g.isJob ? rowInputs(g.main, 'The job') + g.variations.map((v) => rowInputs(v, (v.cost_centres && v.cost_centres.name) || 'Variation')).join('') : `<p class="subtitle">${esc(daysText(g.main.onsite_days))} on site, crew of ${Number(g.main.crew_size)}, ${Number(g.main.lead_weeks)} week gear lead. Change these on the quote, step 3.</p>`}
      <div id="plan-detail-msg"></div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
        ${edit ? '<button type="button" id="plan-save">Save dates</button><button type="button" class="secondary" id="plan-gap">First gap</button>' : ''}
        ${edit && g.span ? `<button type="button" class="${g.slip || !g.main.promised_start ? '' : 'secondary'}" id="plan-email">${g.main.promised_start ? 'Email client the new dates' : 'Email client the dates'}</button><button type="button" class="secondary" id="plan-told">Told by phone</button>` : ''}
        <a class="btn secondary" href="/project.html?id=${esc(p.id)}${g.isJob ? '&tab=schedule' : '&tab=quote'}">${g.isJob ? 'Book people' : 'Open quote'}</a>
        ${g.isJob ? `<a class="btn secondary" href="/project.html?id=${esc(p.id)}&tab=pos">Purchase orders</a>` : ''}
      </div>`, { maxWidth: 620, closeOnBackdrop: true });
    const msg = overlay.querySelector('#plan-detail-msg');
    const fail = (err) => { msg.innerHTML = `<div class="error-box">${esc(err.message)}</div>`; };
    const done = async (focus = true) => { overlay.remove(); await refresh(); if (focus) { const now = find(projectId); if (now && now.slip) openDetail(projectId); } };
    overlay.querySelector('[data-close]').addEventListener('click', () => overlay.remove());
    // the same move as the Job Pipeline board: a plain stage change, the database rules still refuse
    // one that is not allowed (the booked-job gate and the rest) and the reason shows here
    const stageSel = overlay.querySelector('#plan-stage');
    if (stageSel && S.canEdit) stageSel.addEventListener('change', async () => {
      const was = p.pipeline_stage;
      stageSel.disabled = true;
      const { data: row, error } = await supabaseClient.from('projects').update({ pipeline_stage: stageSel.value }).eq('id', p.id).select('pipeline_stage').single();
      stageSel.disabled = false;
      if (error || !row) {
        stageSel.value = was;
        overlay.querySelector('#plan-detail-msg').innerHTML = `<div class="error-box">Could not move: ${esc(friendlyError(error || new Error('no row returned')))}</div>`;
        return;
      }
      showToast(`${ref(p)} moved to ${pipelineStageLabel(row.pipeline_stage)}.`);
      p.pipeline_stage = row.pipeline_stage;
      if (!P.ACTIVE_STAGES.includes(row.pipeline_stage)) { overlay.remove(); await refresh(); }
      else refresh();
    });
    if (!edit) return;

    // a new start keeps the length; days on site typed with no finish work the finish out
    overlay.querySelectorAll('.plan-form').forEach((form) => {
      const w = g.rows.find((r) => r.id === form.dataset.win);
      const f = (name) => form.querySelector(`[data-f="${name}"]`);
      f('start_date').addEventListener('change', () => {
        if (!f('start_date').value) return;
        const start = P.nextWorkDay(f('start_date').value, d.ctx.holidays);
        f('start_date').value = start;
        f('end_date').value = w.start_date && w.end_date ? P.addDays(start, P.daysBetween(w.start_date, w.end_date)) : P.endAfterWorkDays(start, Number(f('onsite_days').value) || 1, d.ctx.holidays);
      });
      f('onsite_days').addEventListener('change', () => {
        if (f('start_date').value) f('end_date').value = P.endAfterWorkDays(f('start_date').value, Number(f('onsite_days').value) || 1, d.ctx.holidays);
      });
    });
    overlay.querySelector('#plan-save').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        for (const form of overlay.querySelectorAll('.plan-form')) {
          const w = g.rows.find((r) => r.id === form.dataset.win);
          const v = (name) => { const n = form.querySelector(`[data-f="${name}"]`); return n ? n.value : null; };
          const start = v('start_date') || null, end = v('end_date') || null;
          if (!!start !== !!end) throw new Error('Give both a start and a finish, or neither.');
          if (start && end < start) throw new Error('The finish is before the start.');
          const patch = { start_date: start, end_date: end, onsite_days: Math.max(0.5, Number(v('onsite_days')) || 1), crew_size: Math.max(1, Math.min(20, parseInt(v('crew_size'), 10) || 1)) };
          if (Number(patch.onsite_days) !== Number(w.onsite_days)) patch.onsite_days_typed = true;
          if (v('lead_weeks') != null) patch.lead_weeks = Math.max(0, Math.min(52, parseInt(v('lead_weeks'), 10) || 0));
          await saveWindow(w.id, patch);
        }
        await done();
      } catch (err) { fail(err); e.target.disabled = false; }
    });
    overlay.querySelector('#plan-gap').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        // measured without this job's own days, so it can move earlier into its own space
        const others = P.buildLoad(d.jobs.filter((o) => o !== g).flatMap((o) => o.rows), d.ctx.holidays);
        const gap = P.firstGap({ days: g.main.onsite_days, crew: g.main.crew_size, earliest: P.addDays(d.today, Number(g.main.lead_weeks) * 7), load: others, ctx: d.ctx });
        await saveWindow(g.main.id, { start_date: gap.start, end_date: gap.end });
        let after = gap.end;
        for (const v of g.variations) {
          const from = P.nextWorkDay(P.addDays(after, 1), d.ctx.holidays);
          after = P.endAfterWorkDays(from, v.onsite_days, d.ctx.holidays);
          await saveWindow(v.id, { start_date: from, end_date: after });
        }
        await done();
      } catch (err) { fail(err); e.target.disabled = false; }
    });
    const emailBtn = overlay.querySelector('#plan-email');
    if (emailBtn) emailBtn.addEventListener('click', () => { overlay.remove(); openEmail(projectId); });
    const toldBtn = overlay.querySelector('#plan-told');
    if (toldBtn) toldBtn.addEventListener('click', async () => {
      toldBtn.disabled = true;
      try { await call({ action: 'told', projectId }); showToast('Saved: the client knows these dates.'); await done(false); } catch (err) { fail(err); toldBtn.disabled = false; }
    });
  }

  async function openEmail(projectId) {
    const overlay = openModal('<p class="subtitle">Writing the email...</p>', { maxWidth: 620 });
    const card = overlay.querySelector('.card');
    try {
      const { draft } = await call({ action: 'draft', projectId });
      card.innerHTML = `
        <h2 style="margin-top:0;">${draft.kind === 'change' ? 'Email the client the new dates' : 'Email the client the dates'}</h2>
        <label>To${draft.source && draft.source !== 'none' ? ` (the ${esc(draft.source)})` : ''}</label><input type="email" id="pe-to" value="${esc(draft.to)}" />
        <label>Subject</label><input id="pe-subject" value="${esc(draft.subject)}" />
        <label>Message</label><textarea id="pe-body" rows="10" spellcheck="true">${esc(draft.body)}</textarea>
        <p class="subtitle" style="margin:6px 0 0;">Sent from sales@ in your name with your signature, and kept on the job's Emails tab.</p>
        <div id="pe-msg"></div>
        <div style="display:flex; gap:8px; margin-top:12px;"><button type="button" id="pe-send">Send</button><button type="button" class="secondary" id="pe-cancel">Cancel</button></div>`;
      card.querySelector('#pe-cancel').addEventListener('click', () => overlay.remove());
      card.querySelector('#pe-send').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          await call({ action: 'send', projectId, to: card.querySelector('#pe-to').value, subject: card.querySelector('#pe-subject').value, body: card.querySelector('#pe-body').value });
          overlay.remove();
          showToast('Sent. The client has these dates.');
          await refresh();
        } catch (err) { card.querySelector('#pe-msg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; e.target.disabled = false; }
      });
    } catch (err) {
      card.innerHTML = `<div class="error-box">${esc(err.message)}</div><button type="button" class="secondary" id="pe-cancel" style="margin-top:10px;">Close</button>`;
      card.querySelector('#pe-cancel').addEventListener('click', () => overlay.remove());
    }
  }

  // ---------- Admin: the numbers the plan runs on, and who is on the tools ----------
  function openSettings() {
    const d = S.data;
    const overlay = openModal(`
      <h2 style="margin-top:0;">Plan settings</h2>
      <div class="plan-form">
        <label>Hours in a site day<input type="number" id="ps-hours" min="1" max="24" step="0.5" value="${d.settings.dayHours}" /></label>
        <label>Usual crew<input type="number" id="ps-crew" min="1" max="20" step="1" value="${d.settings.crew}" /></label>
        <label>Usual gear lead (weeks)<input type="number" id="ps-lead" min="0" max="52" step="1" value="${d.settings.leadWeeks}" /></label>
        <label>Days late before the client is told<input type="number" id="ps-slip" min="0" max="30" step="1" value="${d.settings.slipDays}" /></label>
      </div>
      <label style="margin-top:12px;">On the tools (counted in the crew load)</label>
      <div class="plan-people">${d.people.map((p) => `<label><input type="checkbox" data-person="${esc(p.id)}" ${P.onTools(p) ? 'checked' : ''} /> ${esc(p.full_name || '')}</label>`).join('')}</div>
      <div id="ps-msg"></div>
      <div style="display:flex; gap:8px; margin-top:12px;"><button type="button" id="ps-save">Save</button><button type="button" class="secondary" id="ps-cancel">Cancel</button></div>`, { maxWidth: 560 });
    overlay.querySelector('#ps-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#ps-save').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const num = (id, lo, hi, fallback) => { const n = Number(overlay.querySelector(id).value); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback; };
        const { error } = await supabaseClient.from('company_settings').update({
          plan_day_hours: num('#ps-hours', 1, 24, 8), plan_crew_size: Math.round(num('#ps-crew', 1, 20, 2)),
          plan_lead_weeks: Math.round(num('#ps-lead', 0, 52, 2)), plan_slip_days: Math.round(num('#ps-slip', 0, 30, 2)),
        }).eq('id', 1);
        if (error) throw error;
        for (const box of overlay.querySelectorAll('[data-person]')) {
          const person = d.people.find((p) => p.id === box.dataset.person);
          if (P.onTools(person) === box.checked) continue;
          const { error: pErr } = await supabaseClient.from('profiles').update({ on_tools: box.checked }).eq('id', person.id);
          if (pErr) throw pErr;
        }
        overlay.remove();
        await refresh();
      } catch (err) { overlay.querySelector('#ps-msg').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; e.target.disabled = false; }
    });
  }

  // ---------- the page's handle ----------
  async function refresh() {
    try { await load(); render(); } catch (err) { S.el.innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  }

  // opts: el, canEdit, isAdmin, myId, focus (a job or quote id to open on), onLabel(text, startYmd)
  async function show(opts) {
    Object.assign(S, opts);
    if (!S.start) S.start = mondayOf(today());
    S.el.innerHTML = '<p class="subtitle" style="padding:16px;">Loading the plan...</p>';
    await refresh();
    const g = S.focus && S.data && find(S.focus);
    if (g && g.span && (g.span.start < S.start || g.span.start > P.addDays(S.start, WEEKS * 7 - 1))) { S.start = mondayOf(g.span.start); render(); }
    if (g && g.isJob) openDetail(S.focus);
  }
  const shift = (weeks) => { S.start = P.addDays(S.start, weeks * 7); S.focus = null; if (S.data) render(); };
  const goTo = (ymd) => { S.start = mondayOf(ymd); S.focus = null; if (S.data) render(); };

  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.el && S.data && S.el.offsetParent) render(); }, 200); });

  return { show, shift, goTo };
})();
