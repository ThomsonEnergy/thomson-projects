// The job plan's server side (backlog item 92). One place for:
//   placeJobWindow      a quote was approved: the job goes in the first gap that fits and the
//                       quoter gets the "confirm dates" task (create-job-from-quote.js)
//   addVariationWindow  a variation became a cost centre: its own bar, straight after the job
//                       (create-variation.js, approve-variation.js)
//   markClientTold      the client was told the dates, by email or by phone (plan-email.js)
//   draftClientEmail    the email text for a first confirmation or a change of dates
//   planReminders       the 7am run: slipped jobs, dates not confirmed, order gear, book people,
//                       jobs that did not start (remind-client-bookings.js)
// The maths is public/js/plan-calc.js, the same copy the Plan view and the quote's When card use.
// Writes job_windows, job_tasks, activity_log and notifications (through create_notification).

const P = require('../../../public/js/plan-calc.js');
const E = require('./schedule-emails');

const PRICING_ROLES = ['admin', 'finance', 'sales']; // the same roles as is_pricing_role()
const CONFIRM_TASK = 'Confirm the dates with the client (Schedule, Plan view)';
const planLink = (projectId) => `/schedule.html?view=plan&job=${projectId}`;
const JOB_COLS = 'id, name, job_number, quote_number, client_name, client_email, client_address, job_contact_id, pipeline_stage, source_quote_id';

// Settings, public holidays, who is on the tools and approved leave: what every placement needs.
async function planContext(admin) {
  const today = E.sydneyToday();
  const [settings, holidays, people, leave] = await Promise.all([
    admin.from('company_settings').select('plan_day_hours, plan_crew_size, plan_lead_weeks, plan_slip_days').eq('id', 1).maybeSingle(),
    admin.from('public_holidays').select('holiday_date').gte('holiday_date', today),
    admin.from('profiles').select('id, role, on_tools').eq('active', true),
    admin.from('leave_requests').select('staff_id, start_date, end_date').eq('status', 'approved').gte('end_date', today),
  ]);
  const s = settings.data || {};
  return {
    today,
    settings: { dayHours: Number(s.plan_day_hours) || 8, crew: Number(s.plan_crew_size) || 2, leadWeeks: s.plan_lead_weeks == null ? 2 : Number(s.plan_lead_weeks), slipDays: s.plan_slip_days == null ? 2 : Number(s.plan_slip_days) },
    ctx: {
      holidays: new Set((holidays.data || []).map((h) => h.holiday_date)),
      crew: (people.data || []).filter(P.onTools).map((p) => p.id),
      leave: leave.data || [],
    },
  };
}

// Every window of a job that still has site work ahead, with its job.
async function activeWindows(admin) {
  const { data, error } = await admin.from('job_windows').select(`*, projects!inner(${JOB_COLS})`)
    .not('projects.job_number', 'is', null).in('projects.pipeline_stage', P.ACTIVE_STAGES);
  if (error) throw error;
  return data || [];
}

async function jobWindows(admin, projectId) {
  const { data, error } = await admin.from('job_windows').select('*').eq('project_id', projectId);
  if (error) throw error;
  const rows = data || [];
  return { rows, main: rows.find((w) => !w.cost_centre_id) || null };
}

// Who chases a job's dates: the quoter when they can still act, otherwise the ops managers
// and every active Admin, Finance and Sales person (the fallback remind-client-bookings uses).
async function chasers(admin, quoterId) {
  if (quoterId) {
    const { data } = await admin.from('profiles').select('id, role, active').eq('id', quoterId).maybeSingle();
    if (data && data.active && PRICING_ROLES.includes(data.role)) return [data.id];
  }
  const [{ data: managers }, { data: pricing }] = await Promise.all([
    admin.from('company_settings').select('ops_manager_user_ids').eq('id', 1).maybeSingle(),
    admin.from('profiles').select('id').in('role', PRICING_ROLES).eq('active', true),
  ]);
  return [...new Set([...((managers && managers.ops_manager_user_ids) || []), ...(pricing || []).map((p) => p.id)])];
}

async function notify(admin, userIds, { title, body, projectId, dedupe, actorId = null }) {
  for (const uid of userIds) {
    if (uid === actorId) continue; // the person who just did it does not need telling
    await admin.rpc('create_notification', { p_user: uid, p_kind: 'booking_reminder', p_title: title, p_body: body, p_link: planLink(projectId), p_actor: actorId, p_dedupe: dedupe });
  }
}

const labourHours = (stages) => (stages || []).reduce((sum, s) => sum + (s.cost_centre_line_items || []).filter((li) => li.item_type === 'labour').reduce((h, li) => h + (Number(li.quantity) || 0), 0), 0);

// A quote was approved. quote carries cost_centres(cost_centre_line_items); job is the new row.
// Safe to call twice: a job that already has its window is left alone.
async function placeJobWindow(admin, { quote, job }) {
  const have = await jobWindows(admin, job.id);
  if (have.main) return have.main;
  const plan = await planContext(admin);
  const { data: qw } = await admin.from('job_windows').select('onsite_days, onsite_days_typed, crew_size, lead_weeks').eq('project_id', quote.id).is('cost_centre_id', null).maybeSingle();
  const crew = (qw && qw.crew_size) || plan.settings.crew;
  const days = qw ? Number(qw.onsite_days) : P.daysFromHours(labourHours(quote.cost_centres), crew, plan.settings.dayHours);
  const leadWeeks = qw ? qw.lead_weeks : plan.settings.leadWeeks;
  const load = P.buildLoad((await activeWindows(admin)).filter((w) => w.start_date), plan.ctx.holidays);
  const gap = P.firstGap({ days, crew, earliest: P.addDays(plan.today, leadWeeks * 7), load, ctx: plan.ctx });
  const { data: win, error } = await admin.from('job_windows').insert({
    project_id: job.id, onsite_days: days, onsite_days_typed: !!(qw && qw.onsite_days_typed), crew_size: crew, lead_weeks: leadWeeks,
    start_date: gap.start, end_date: gap.end, quoter_id: quote.created_by || null,
  }).select('*').single();
  if (error) {
    if (error.code === '23505') return (await jobWindows(admin, job.id)).main; // two approvals at once
    throw error;
  }
  const people = await chasers(admin, quote.created_by);
  const quoterActs = people.length === 1 && people[0] === quote.created_by;
  await admin.from('job_tasks').insert({
    project_id: job.id, description: CONFIRM_TASK, task_type: 'prejob',
    assigned_to_user_id: quoterActs ? quote.created_by : null, assigned_to_role: quoterActs ? null : 'sales',
    due_date: P.nextWorkDay(P.addDays(plan.today, 1), plan.ctx.holidays),
  });
  await notify(admin, people, {
    title: `Confirm dates with the client: ${E.jobTitle(job)}`,
    body: `Approved and planned for ${P.fmtRange(gap.start, gap.end)}. Check the dates on the Plan, then email them to ${job.client_name || 'the client'} or mark as told by phone.`,
    projectId: job.id, dedupe: `plan-confirm:${job.id}`,
  });
  return win;
}

// A variation became a cost centre on the job: its own window. A fixed price one (onDate unset)
// goes straight after the job's last planned day (or from today when that has passed); a do and
// charge one is work done on site on the day it was logged (onDate), so it sits on that day. A
// job with no dates yet gets a window with no dates, placed with the job. Tells whoever chases
// the job when the variation takes it past what the client was told.
async function addVariationWindow(admin, { projectId, centreId, hours, onDate = null, actorId = null }) {
  const { rows, main } = await jobWindows(admin, projectId);
  if (rows.some((w) => w.cost_centre_id === centreId)) return null;
  const plan = await planContext(admin);
  const crew = (main && main.crew_size) || plan.settings.crew;
  const days = P.daysFromHours(hours, crew, plan.settings.dayHours);
  const span = P.jobSpan(rows);
  let dates = { start_date: null, end_date: null };
  if (onDate) {
    const day = P.nextWorkDay(onDate, plan.ctx.holidays);
    dates = { start_date: day, end_date: P.endAfterWorkDays(day, days, plan.ctx.holidays) };
  } else if (span) {
    const from = P.nextWorkDay(span.end >= plan.today ? P.addDays(span.end, 1) : plan.today, plan.ctx.holidays);
    dates = { start_date: from, end_date: P.endAfterWorkDays(from, days, plan.ctx.holidays) };
  }
  const { data: win, error } = await admin.from('job_windows').insert({
    project_id: projectId, cost_centre_id: centreId, onsite_days: days, crew_size: crew, lead_weeks: 0,
    ...dates, quoter_id: (main && main.quoter_id) || null, updated_by: actorId,
  }).select('*').single();
  if (error) {
    if (error.code === '23505') return null;
    throw error;
  }
  const slip = P.slipFor(main, [...rows, win], plan.settings.slipDays, plan.ctx.holidays);
  if (slip) {
    const { data: job } = await admin.from('projects').select(JOB_COLS).eq('id', projectId).maybeSingle();
    if (job) {
      await notify(admin, await chasers(admin, main.quoter_id), {
        title: `Tell the client: ${E.jobTitle(job)} now runs to ${P.fmtDay(slip.span.end)}`,
        body: `A variation takes the job past ${P.fmtDay(main.promised_end)}, the finish ${job.client_name || 'the client'} was told. Email the new dates from the Plan.`,
        projectId, dedupe: `plan-slip:${projectId}:${slip.span.start}:${slip.span.end}`,
      });
    }
  }
  return win;
}

// The email text. kind 'confirm' is the first time the client hears the dates; 'change' is a
// job that has moved outside them. Ends without a sign off: the sender's signature adds it.
function clientEmailText({ kind, first, job, main, rows, phone }) {
  const span = P.jobSpan(rows);
  const days = rows.filter((w) => w.start_date).reduce((sum, w) => sum + Number(w.onsite_days || 0), 0);
  const onSite = `about ${days} day${days === 1 ? '' : 's'} on site`;
  const closing = `We will confirm the exact days and times closer to the start. If these dates do not suit you, reply to this email or call us on ${phone}.`;
  if (kind === 'change') {
    return {
      subject: `New dates for ${E.jobTitle(job)}`,
      body: `Hi ${first},\n\nThe dates for ${E.jobTitle(job)} have changed. We told you ${P.fmtRange(main.promised_start, main.promised_end)}. The work is now planned for ${P.fmtRange(span.start, span.end)}, ${onSite}.\n\nSorry for the change. ${closing}`,
    };
  }
  return {
    subject: `Your dates for ${E.jobTitle(job)}`,
    body: `Hi ${first},\n\nThank you for going ahead with ${E.jobTitle(job)}. We have the work planned for ${P.fmtRange(span.start, span.end)}, ${onSite}.\n\n${closing}`,
  };
}

async function loadJob(admin, projectId) {
  const { data: job } = await admin.from('projects').select(JOB_COLS).eq('id', projectId).maybeSingle();
  if (!job || !job.job_number) { const e = new Error('Job not found.'); e.statusCode = 404; throw e; }
  const { rows, main } = await jobWindows(admin, projectId);
  if (!main || !P.jobSpan(rows)) { const e = new Error('This job has no dates on the Plan yet. Give it dates first.'); e.statusCode = 400; throw e; }
  return { job, rows, main };
}

async function draftClientEmail(admin, projectId) {
  const { job, rows, main } = await loadJob(admin, projectId);
  const [rec, phone] = await Promise.all([E.recipientFor(admin, job), E.companyPhone(admin)]);
  const kind = main.promised_start ? 'change' : 'confirm';
  const text = clientEmailText({ kind, first: rec.first, job, main, rows, phone });
  // a client who can log in to the portal is pointed at it, where these dates show too (item 74 PR 2)
  if (rec.to) text.body += await require('./portal-mail').portalLine(admin, rec.to);
  return { kind, to: rec.to, toName: rec.name, source: rec.source, ...text };
}

// The client now knows the dates on the Plan: they become the promised dates (the job's whole
// span on its own window, each variation's own dates on its window) and the task is ticked.
async function markClientTold(admin, { projectId, userId, how }) {
  const { job, rows, main } = await loadJob(admin, projectId);
  const span = P.jobSpan(rows);
  const now = new Date().toISOString();
  const stamp = { client_confirmed_at: now, client_confirmed_by: userId, client_confirmed_how: how, updated_by: userId, updated_at: now };
  for (const w of rows) {
    const promised = w.id === main.id ? { promised_start: span.start, promised_end: span.end } : { promised_start: w.start_date, promised_end: w.end_date };
    const { error } = await admin.from('job_windows').update({ ...stamp, ...promised }).eq('id', w.id);
    if (error) throw error;
  }
  await admin.from('job_tasks').update({ completed: true, completed_by: userId, completed_at: now }).eq('project_id', projectId).eq('description', CONFIRM_TASK).eq('completed', false);
  await admin.from('activity_log').insert({
    entity_type: 'project', entity_id: projectId, action: 'plan_dates_told', changed_by: userId,
    description: `Client told the dates ${how === 'email' ? 'by email' : 'by phone'}: ${P.fmtRange(span.start, span.end)}${main.promised_start ? ` (was ${P.fmtRange(main.promised_start, main.promised_end)})` : ''}`,
  });
  return { job, span };
}

// The 7am run. One notification per job per reason; the dedupe keys keep a reason from repeating
// until something about it changes, except a slipped job and a job that did not start, which
// repeat every day until someone acts.
async function planReminders(admin) {
  const plan = await planContext(admin);
  const { today, ctx, settings } = plan;
  const windows = await activeWindows(admin);
  const byJob = new Map();
  for (const w of windows) {
    const g = byJob.get(w.project_id) || { job: w.projects, rows: [] };
    g.rows.push(w);
    byJob.set(w.project_id, g);
  }
  const ids = [...byJob.keys()];
  if (!ids.length) return { count: 0, lines: [] };
  const [{ data: pos }, { data: bookings }, { data: shifts }, { data: managerRow }] = await Promise.all([
    admin.from('purchase_orders').select('project_id').in('project_id', ids),
    // bookings from 90 days back on (a request returns at most 1,000 rows: old bookings are not needed)
    admin.from('schedule_assignments').select('project_id, assignment_date').in('project_id', ids).eq('block_type', 'job').gte('assignment_date', P.addDays(today, -90)),
    // only whether a job whose planned start has passed has any shift at all: one row each is enough
    (() => {
      const late = [...byJob.entries()].filter(([, g]) => { const sp = P.jobSpan(g.rows); return sp && sp.start < today; }).map(([id]) => id);
      return late.length ? admin.from('time_entries').select('project_id').in('project_id', late) : Promise.resolve({ data: [] });
    })(),
    admin.from('company_settings').select('ops_manager_user_ids').eq('id', 1).maybeSingle(),
  ]);
  const hasPo = new Set((pos || []).map((r) => r.project_id));
  const hasShift = new Set((shifts || []).map((r) => r.project_id));
  const managers = (managerRow && managerRow.ops_manager_user_ids) || [];
  const lines = [];
  for (const [projectId, g] of byJob) {
    const main = g.rows.find((w) => !w.cost_centre_id);
    const span = P.jobSpan(g.rows);
    if (!main || !span) continue;
    const title = E.jobTitle(g.job);
    const client = g.job.client_name || 'the client';
    const booked = (bookings || []).filter((b) => b.project_id === projectId && b.assignment_date >= span.start && b.assignment_date <= span.end);
    const slip = P.slipFor(main, g.rows, settings.slipDays, ctx.holidays);
    if (slip) {
      await notify(admin, await chasers(admin, main.quoter_id), {
        title: `Tell the client: ${title} has moved`,
        body: `${client} was told ${P.fmtRange(main.promised_start, main.promised_end)}. It is now planned for ${P.fmtRange(span.start, span.end)}. Email the new dates from the Plan.`,
        projectId, dedupe: `plan-slip:${projectId}:${today}`,
      });
      lines.push(`${title}: client not told of the new dates`);
    } else if (!main.promised_start && span.start >= today && P.daysBetween(today, span.start) <= 21) {
      await notify(admin, await chasers(admin, main.quoter_id), {
        title: `Dates not confirmed with the client: ${title}`,
        body: `Planned for ${P.fmtRange(span.start, span.end)} and ${client} has not been told. Email the dates from the Plan, or mark as told by phone.`,
        projectId, dedupe: `plan-confirm:${projectId}:${today}`,
      });
      lines.push(`${title}: dates not confirmed`);
    }
    if (span.start < today && !booked.length && !hasShift.has(projectId)) {
      await notify(admin, [...new Set([...(await chasers(admin, main.quoter_id)), ...managers])], {
        title: `Did not start: ${title}`,
        body: `Planned to start ${P.fmtDay(span.start)} with nobody booked and no time clocked. Move it on the Plan to when it will run.`,
        projectId, dedupe: `plan-late:${projectId}:${today}`,
      });
      lines.push(`${title}: planned start has passed`);
      continue;
    }
    if (span.start < today) continue;
    const orderBy = P.addDays(main.start_date || span.start, -(Number(main.lead_weeks) || 0) * 7);
    if (!hasPo.has(projectId) && Number(main.lead_weeks) > 0 && P.daysBetween(today, orderBy) <= 7) {
      const due = orderBy <= today;
      await notify(admin, managers, {
        title: `Order gear for ${title} ${due ? 'now' : `by ${P.fmtDay(orderBy)}`}`,
        body: `Starts ${P.fmtDay(span.start)} with a ${main.lead_weeks} week lead time and no purchase order on the job yet.`,
        projectId, dedupe: `plan-order:${projectId}:${orderBy}:${due ? 'due' : 'soon'}`,
      });
      lines.push(`${title}: order gear`);
    }
    const toStart = P.daysBetween(today, span.start);
    if (!booked.length && toStart <= 14) {
      await notify(admin, managers, {
        title: `Book people for ${title}, starts ${P.fmtDay(span.start)}`,
        body: `${main.onsite_days} day${Number(main.onsite_days) === 1 ? '' : 's'} on site with a crew of ${main.crew_size}, and nobody is booked for ${P.fmtRange(span.start, span.end)}.`,
        projectId, dedupe: `plan-book:${projectId}:${span.start}:${toStart <= 3 ? 'due' : 'soon'}`,
      });
      lines.push(`${title}: nobody booked`);
    }
  }
  return { count: lines.length, lines };
}

module.exports = { placeJobWindow, addVariationWindow, draftClientEmail, markClientTold, planReminders, labourHours };
