// The job plan's maths (backlog item 92), one copy for the browser and the server:
// working days, on-site days from labour hours, the crew load per day, the first gap a job
// fits in, the wait range to tell a client, and whether a job has slipped past the dates the
// client was told. Loaded by schedule.html (js/plan-chart.js) and project.html
// (js/job-window.js), and required by netlify/functions/_shared/job-plan.js, so it stays plain
// script plus the module.exports guard at the bottom: no DOM access, no database.
// Dates are 'YYYY-MM-DD' strings throughout. Writes nothing.

const PlanCalc = (() => {
  const toDate = (ymd) => new Date(ymd + 'T00:00:00Z');
  const addDays = (ymd, n) => { const d = toDate(ymd); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
  const isWorkDay = (ymd, holidays) => { const dow = toDate(ymd).getUTCDay(); return dow !== 0 && dow !== 6 && !(holidays && holidays.has(ymd)); };
  // the first working day on or after this date
  const nextWorkDay = (ymd, holidays) => { let d = ymd; while (!isWorkDay(d, holidays)) d = addDays(d, 1); return d; };
  // the last day of a run of `days` working days that starts on `start` (a working day)
  const endAfterWorkDays = (start, days, holidays) => {
    let d = nextWorkDay(start, holidays);
    for (let left = Math.max(1, Math.ceil(days)) - 1; left > 0; left -= 1) d = nextWorkDay(addDays(d, 1), holidays);
    return d;
  };
  const workDaysIn = (start, end, holidays) => {
    const out = [];
    for (let d = start; d <= end; d = addDays(d, 1)) if (isWorkDay(d, holidays)) out.push(d);
    return out;
  };
  // how many working days `to` is after `from` (0 when the same day or earlier)
  const workDaysLate = (from, to, holidays) => (to > from ? workDaysIn(addDays(from, 1), to, holidays).length : 0);

  // On-site days for a quote: labour hours shared between the crew, whole days, at least one.
  const daysFromHours = (hours, crew, dayHours) => Math.max(1, Math.ceil((Number(hours) || 0) / (Math.max(1, Number(crew) || 1) * (Number(dayHours) || 8))));

  // People planned per day. A window longer than its on-site days spreads them evenly.
  function buildLoad(windows, holidays) {
    const load = new Map();
    for (const w of windows || []) {
      if (!w.start_date || !w.end_date) continue;
      const days = workDaysIn(w.start_date, w.end_date, holidays);
      if (!days.length) continue;
      const perDay = (Number(w.crew_size) || 1) * Math.min(1, (Number(w.onsite_days) || days.length) / days.length);
      days.forEach((d) => load.set(d, (load.get(d) || 0) + perDay));
    }
    return load;
  }

  // People on the tools that day: the crew less anyone on approved leave.
  function capacityOn(ymd, ctx) {
    const crew = ctx.crew || [];
    const away = new Set((ctx.leave || []).filter((l) => l.start_date <= ymd && l.end_date >= ymd).map((l) => l.staff_id));
    return crew.filter((id) => !away.has(id)).length;
  }

  // The first run of working days, on or after `earliest`, where the crew fits on every day.
  // With nobody ticked as on the tools there is nothing to measure against, so the earliest
  // date stands. A job that needs more people than the whole crew takes days with nothing on.
  function firstGap({ days, crew, earliest, load, ctx }) {
    const need = Math.max(1, Number(crew) || 1);
    const n = Math.max(1, Math.ceil(Number(days) || 1));
    const holidays = ctx.holidays;
    let start = nextWorkDay(earliest, holidays);
    if (!(ctx.crew || []).length) return { start, end: endAfterWorkDays(start, n, holidays), measured: false };
    for (let tries = 0; tries < 400; tries += 1) {
      const end = endAfterWorkDays(start, n, holidays);
      const clash = workDaysIn(start, end, holidays).find((d) => {
        const cap = capacityOn(d, ctx);
        const used = load.get(d) || 0;
        return need > cap ? used > 0.01 || cap === 0 : used + need > cap + 0.01;
      });
      if (!clash) return { start, end, measured: true };
      start = nextWorkDay(addDays(clash, 1), holidays);
    }
    return { start, end: endAfterWorkDays(start, n, holidays), measured: true, full: true };
  }

  // What to tell the client: whole weeks from today to the start, as a range.
  function waitRange(today, start) {
    const lo = Math.max(1, Math.ceil(daysBetween(today, start) / 7));
    const hi = lo + (lo >= 3 ? 2 : 1);
    return { lo, hi, text: `${lo} to ${hi} weeks` };
  }

  // A job's whole span: the main window and every variation window that has dates.
  function jobSpan(windows) {
    const dated = (windows || []).filter((w) => w.start_date && w.end_date);
    if (!dated.length) return null;
    return { start: dated.map((w) => w.start_date).sort()[0], end: dated.map((w) => w.end_date).sort().pop() };
  }

  // Has the job moved outside what the client was told? main is the job's own window (it holds
  // the promised dates), windows is main plus the variations. Null when nothing to tell.
  function slipFor(main, windows, allowance, holidays) {
    if (!main || !main.promised_start || !main.promised_end) return null;
    const span = jobSpan(windows);
    if (!span) return null;
    if (span.start < main.promised_start) return { kind: 'earlier', span };
    if (workDaysLate(main.promised_start, span.start, holidays) > (Number(allowance) || 0)) return { kind: 'later', span };
    if (span.end > main.promised_end) return { kind: 'longer', span };
    return null;
  }

  const fmtDay = (ymd) => toDate(ymd).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
  const fmtRange = (start, end) => (start === end ? fmtDay(start) : `${fmtDay(start)} to ${fmtDay(end)}`);
  // null on_tools follows the role: Staff are on the tools unless unticked
  const onTools = (p) => (p.on_tools == null ? p.role === 'staff' : !!p.on_tools);
  // jobs that still have site work ahead of them
  const ACTIVE_STAGES = ['quote_approved', 'deposit_paid', 'awaiting_action', 'awaiting_client_action', 'ready_to_book', 'job_booked', 'job_not_complete'];

  return { addDays, daysBetween, isWorkDay, nextWorkDay, endAfterWorkDays, workDaysIn, workDaysLate, daysFromHours, buildLoad, capacityOn, firstGap, waitRange, jobSpan, slipFor, fmtDay, fmtRange, onTools, ACTIVE_STAGES };
})();

// Server side (netlify/functions/_shared/job-plan.js) requires this file. Browsers never see this branch.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PlanCalc;
}
