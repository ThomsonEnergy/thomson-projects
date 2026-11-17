// The "When" card on a quote (backlog item 92), in step 3 of the quote steps on project.html.
// Works out the on-site days from the quote's labour hours, finds the first gap in the plan the
// job would fit, and shows the wait to tell the client. It saves by itself (no button): the
// quote's row in job_windows carries the days, crew, gear lead time and the wait text, which
// the Plan view (js/plan-chart.js), the proposal (quote.html, get_quote_wait) and the job made on
// approval (_shared/job-plan.js) all read. The maths is js/plan-calc.js.
// Pricing roles only (the card sits in the quote steps, which only they see).
// Reads company_settings, public_holidays, profiles, leave_requests, job_windows,
// cost_centres(cost_centre_line_items). Writes the quote's own job_windows row.

async function initJobWindow(project) {
  const host = document.getElementById('job-window-card');
  if (!host || project.job_number || ['approved', 'declined'].includes(project.status)) return;
  const esc = (s) => escapeHtml(s);
  try {
    await loadJsOnce('/js/plan-calc.js?v=1', () => typeof PlanCalc !== 'undefined');
    const P = PlanCalc;
    const today = sydneyDateKey(new Date());
    const q = (p) => p.then(({ data, error }) => { if (error) throw error; return data || []; });
    const [settingsRows, holidays, people, leave, windows, centres, { data: { user } }] = await Promise.all([
      q(supabaseClient.from('company_settings').select('plan_day_hours, plan_crew_size, plan_lead_weeks').eq('id', 1)),
      q(supabaseClient.from('public_holidays').select('holiday_date').gte('holiday_date', today)),
      q(supabaseClient.from('profiles').select('id, role, on_tools').eq('active', true)),
      q(supabaseClient.from('leave_requests').select('staff_id, start_date, end_date').eq('status', 'approved').gte('end_date', today)),
      q(supabaseClient.from('job_windows').select('*, projects!inner(job_number, pipeline_stage)')),
      q(supabaseClient.from('cost_centres').select('id, variation_entry_id, cost_centre_line_items(item_type, quantity)').eq('project_id', project.id)),
      supabaseClient.auth.getUser(),
    ]);
    const s = settingsRows[0] || {};
    const dayHours = Number(s.plan_day_hours) || 8;
    const ctx = { holidays: new Set(holidays.map((h) => h.holiday_date)), crew: people.filter(P.onTools).map((p) => p.id), leave };
    const load = P.buildLoad(windows.filter((w) => w.projects.job_number && P.ACTIVE_STAGES.includes(w.projects.pipeline_stage) && w.start_date), ctx.holidays);
    const hours = centres.filter((c) => !c.variation_entry_id).reduce((sum, c) => sum + (c.cost_centre_line_items || []).filter((li) => li.item_type === 'labour').reduce((h, li) => h + (Number(li.quantity) || 0), 0), 0);
    let row = windows.find((w) => w.project_id === project.id && !w.cost_centre_id) || null;
    const state = {
      typed: !!(row && row.onsite_days_typed),
      crew: row ? Number(row.crew_size) : Number(s.plan_crew_size) || 2,
      lead: row ? Number(row.lead_weeks) : (s.plan_lead_weeks == null ? 2 : Number(s.plan_lead_weeks)),
      days: row ? Number(row.onsite_days) : 1,
    };

    const work = () => {
      if (!state.typed) state.days = P.daysFromHours(hours, state.crew, dayHours);
      const gap = P.firstGap({ days: state.days, crew: state.crew, earliest: P.addDays(today, state.lead * 7), load, ctx });
      return { gap, wait: P.waitRange(today, gap.start) };
    };

    // saved by itself whenever what the card shows differs from what is stored
    let saving = Promise.resolve();
    const save = (wait) => {
      const want = { onsite_days: state.days, onsite_days_typed: state.typed, crew_size: state.crew, lead_weeks: state.lead, wait_text: wait.text };
      if (row && Object.keys(want).every((k) => String(row[k]) === String(want[k]))) return;
      saving = saving.then(async () => {
        const stamp = { ...want, updated_by: user && user.id, updated_at: new Date().toISOString() };
        const res = row
          ? await supabaseClient.from('job_windows').update(stamp).eq('id', row.id).select('*').single()
          : await supabaseClient.from('job_windows').insert({ ...stamp, project_id: project.id, quoter_id: project.created_by || (user && user.id) }).select('*').single();
        if (res.error) throw res.error;
        row = res.data;
      }).catch((err) => { const m = host.querySelector('#jw-msg'); if (m) m.innerHTML = `<div class="error-box">${esc(err.message)}</div>`; });
    };

    const draw = () => {
      const { gap, wait } = work();
      const load1 = ctx.crew.length ? '' : ' Nobody is ticked as on the tools yet (Schedule, Plan, Plan settings), so this is the gear lead time only.';
      host.innerHTML = `
        <div style="margin-top:16px; padding:12px; background:var(--surface-2); border-radius:8px;">
          <label style="margin-top:0; font-weight:600;">When</label>
          <p class="subtitle" style="margin:2px 0 8px;">Days on site come from the labour hours on this quote (${esc(Math.round(hours * 10) / 10)} hours, ${esc(dayHours)} hour days). Type over them if you know better.</p>
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:10px; align-items:end;">
            <div><label style="margin-top:0;">Days on site</label><input type="number" id="jw-days" min="0.5" step="0.5" value="${state.days}" /></div>
            <div><label style="margin-top:0;">Crew</label><input type="number" id="jw-crew" min="1" max="20" step="1" value="${state.crew}" /></div>
            <div><label style="margin-top:0;">Gear lead (weeks)</label><input type="number" id="jw-lead" min="0" max="52" step="1" value="${state.lead}" /></div>
          </div>
          ${state.typed ? '<p class="subtitle" style="margin:6px 0 0;">Days typed by hand. <a href="#" id="jw-reset">Go back to the labour hours</a></p>' : ''}
          <p style="margin:10px 0 2px; font-size:15px;">Tell the client: <strong>${esc(wait.text)}</strong></p>
          <p class="subtitle" style="margin:0;">If approved today it would run ${esc(P.fmtRange(gap.start, gap.end))}.${gap.full ? ' The plan is full for the next year: check it.' : ''}${load1} The proposal says "Estimated start: ${esc(wait.text)} from acceptance". <a href="/schedule.html?view=plan&quote=${esc(project.id)}">See it on the Plan</a></p>
          <div id="jw-msg"></div>
        </div>`;
      const num = (id, lo, hi, fallback) => { const n = Number(host.querySelector(id).value); return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, n)) : fallback; };
      host.querySelector('#jw-days').addEventListener('change', () => { state.days = num('#jw-days', 0.5, 400, state.days); state.typed = true; draw(); });
      host.querySelector('#jw-crew').addEventListener('change', () => { state.crew = Math.round(num('#jw-crew', 1, 20, state.crew)); draw(); });
      host.querySelector('#jw-lead').addEventListener('change', () => { const n = Number(host.querySelector('#jw-lead').value); state.lead = Number.isFinite(n) ? Math.max(0, Math.min(52, Math.round(n))) : state.lead; draw(); });
      const reset = host.querySelector('#jw-reset');
      if (reset) reset.addEventListener('click', (e) => { e.preventDefault(); state.typed = false; draw(); });
      save(wait);
    };
    draw();
  } catch (err) {
    host.innerHTML = `<div class="error-box" style="margin-top:12px;">The When card could not load: ${esc(err.message)}</div>`;
  }
}
