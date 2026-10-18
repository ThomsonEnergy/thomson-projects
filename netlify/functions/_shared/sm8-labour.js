// ServiceM8 import, labour and checklists: run by
// sm8-copy-attachments-background.js before the docs and photos, for every
// job already imported (projects.sm8_job_uuid). Only reads from ServiceM8.
//
// Labour: each recorded check-in/check-out on the job (jobactivity with
// activity_was_recorded = 1; scheduled bookings are skipped) becomes a time
// entry on the job for the TEops person matched to that ServiceM8 staff
// member (profiles.sm8_staff_uuid, set with sm8-staff.js). Those hours were
// already paid through Xero, so the entry is marked pushed (xero_pushed_at)
// and push-timesheets-to-xero.js leaves it alone. They count toward the
// job's labour cost but stay off people's own Timesheets pages. Staff with
// no match are counted, not imported; match them and run it again.
//
// Checklists: every checklist item, ticked or not, becomes a task on the
// job, ticked if it was ticked in ServiceM8. Nobody is assigned, so nobody
// gets a notification for 100 old tasks.
//
// Safe to re-run: each ServiceM8 record id is stored once (unique indexes,
// migration 20261021000000). A re-run moves time to a newly matched person
// and ticks tasks that were ticked in ServiceM8 since.

const { sm8GetAll } = require('./sm8-import');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isOn = (v) => v === 1 || v === '1' || v === true;
const clean = (s) => String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// ServiceM8 dates are "YYYY-MM-DD HH:MM:SS" in the account's local time
// (Sydney); an unset one is empty or all zeros. Returns a UTC ISO string,
// DST-safe: the Sydney offset is worked out for that instant with Intl.
const SYD = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function sydneyOffsetMs(t) {
  const p = Object.fromEntries(SYD.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
}
function sm8DateToIso(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m || m[1] === '0000') return null;
  const local = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let t = local - sydneyOffsetMs(local);
  t = local - sydneyOffsetMs(t);
  return new Date(t).toISOString();
}

async function copyJobLabour(supabaseAdmin, project, activities, profileByStaff, centreId, summary) {
  const { data: existing, error } = await supabaseAdmin.from('time_entries')
    .select('id, staff_id, sm8_activity_uuid').eq('project_id', project.id).not('sm8_activity_uuid', 'is', null);
  if (error) throw error;
  const existingByUuid = new Map((existing || []).map(e => [e.sm8_activity_uuid, e]));
  const nowIso = new Date().toISOString();
  const inserts = [];

  for (const a of activities) {
    const clockIn = sm8DateToIso(a.start_date);
    const clockOut = sm8DateToIso(a.end_date);
    if (!clockIn || !clockOut || clockOut <= clockIn) { summary.timeSkippedNoTimes++; continue; }
    const staffId = profileByStaff.get(a.staff_uuid);
    if (!staffId) {
      summary.timeSkippedUnmatched++;
      summary.unmatchedStaff[a.staff_uuid || 'none'] = (summary.unmatchedStaff[a.staff_uuid || 'none'] || 0) + 1;
      continue;
    }
    const had = existingByUuid.get(a.uuid);
    if (had) {
      if (had.staff_id !== staffId) {
        const { error: upErr } = await supabaseAdmin.from('time_entries').update({ staff_id: staffId }).eq('id', had.id);
        if (upErr) throw upErr;
        summary.timeMoved++;
      } else summary.timeAlready++;
      continue;
    }
    inserts.push({
      staff_id: staffId,
      project_id: project.id,
      cost_centre_id: centreId,
      time_category: 'job',
      clock_in: clockIn,
      clock_out: clockOut,
      notes: `ServiceM8 job #${project.sm8_job_number || '?'} check-in`,
      xero_pushed_at: nowIso,
      sm8_activity_uuid: a.uuid,
    });
  }
  if (inserts.length) {
    const { data, error: insErr } = await supabaseAdmin.from('time_entries')
      .upsert(inserts, { onConflict: 'sm8_activity_uuid', ignoreDuplicates: true }).select('id');
    if (insErr) throw insErr;
    summary.timeAdded += (data || []).length;
  }
}

async function copyJobChecklist(supabaseAdmin, userId, project, items, profileByStaff, summary) {
  const { data: existing, error } = await supabaseAdmin.from('job_tasks')
    .select('id, completed, sm8_checklist_uuid').eq('project_id', project.id).not('sm8_checklist_uuid', 'is', null);
  if (error) throw error;
  const existingByUuid = new Map((existing || []).map(t => [t.sm8_checklist_uuid, t]));
  const inserts = [];

  for (const item of items.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))) {
    const description = clean(item.name);
    if (!description) continue;
    const completedAt = sm8DateToIso(item.completed_timestamp);
    const completedBy = profileByStaff.get(item.completed_by_staff_uuid) || null;
    const had = existingByUuid.get(item.uuid);
    if (had) {
      if (completedAt && !had.completed) {
        const { error: upErr } = await supabaseAdmin.from('job_tasks')
          .update({ completed: true, completed_at: completedAt, completed_by: completedBy }).eq('id', had.id);
        if (upErr) throw upErr;
        summary.checklistTicked++;
      } else summary.checklistAlready++;
      continue;
    }
    inserts.push({
      project_id: project.id,
      description,
      task_type: 'onsite',
      completed: !!completedAt,
      completed_at: completedAt,
      completed_by: completedAt ? completedBy : null,
      created_by: userId,
      sort_order: Number(item.sort_order) || null,
      notes: 'From the ServiceM8 checklist',
      sm8_checklist_uuid: item.uuid,
    });
  }
  if (inserts.length) {
    const { data, error: insErr } = await supabaseAdmin.from('job_tasks')
      .upsert(inserts, { onConflict: 'sm8_checklist_uuid', ignoreDuplicates: true }).select('id');
    if (insErr) throw insErr;
    summary.checklistAdded += (data || []).length;
  }
}

// summary is filled in place so the caller can save it even if this throws.
async function copyLabourAndChecklists(supabaseAdmin, apiKey, userId, summary) {
  Object.assign(summary, {
    jobs: 0, jobErrors: [],
    timeAdded: 0, timeAlready: 0, timeMoved: 0, timeSkippedUnmatched: 0, timeSkippedNoTimes: 0, unmatchedStaff: {},
    checklistAdded: 0, checklistAlready: 0, checklistTicked: 0,
  });

  const [{ data: projects, error }, { data: linked, error: linkErr }] = await Promise.all([
    supabaseAdmin.from('projects').select('id, job_number, sm8_job_uuid, sm8_job_number, cost_centres(id)').not('sm8_job_uuid', 'is', null),
    supabaseAdmin.from('profiles').select('id, sm8_staff_uuid').not('sm8_staff_uuid', 'is', null),
  ]);
  if (error) throw error;
  if (linkErr) throw linkErr;
  const profileByStaff = new Map((linked || []).map(p => [p.sm8_staff_uuid, p.id]));

  // Per job rather than one bulk call: ServiceM8's filter has no "in", and
  // the whole account's history of check-ins can be far bigger than the
  // imported jobs' share. Paced to stay under ~180 calls a minute.
  for (const project of projects || []) {
    try {
      const [activities, items] = await Promise.all([
        sm8GetAll(apiKey, 'jobactivity', `job_uuid eq '${project.sm8_job_uuid}' and active eq 1`),
        sm8GetAll(apiKey, 'jobchecklist', `job_uuid eq '${project.sm8_job_uuid}' and active eq 1`),
      ]);
      // A job with one stage puts the time on it; otherwise it is left
      // unassigned to a stage, like a clock-in that picked none.
      const centreId = (project.cost_centres || []).length === 1 ? project.cost_centres[0].id : null;
      await copyJobLabour(supabaseAdmin, project, activities.filter(a => isOn(a.activity_was_recorded)), profileByStaff, centreId, summary);
      await copyJobChecklist(supabaseAdmin, userId, project, items, profileByStaff, summary);
      summary.jobs++;
    } catch (err) {
      console.error('sm8-labour job error:', project.sm8_job_uuid, err.message);
      summary.jobErrors.push({ jobNumber: project.job_number, error: String(err.message).slice(0, 300) });
    }
    await sleep(800);
  }

  // Name the staff with no match, for the import screen.
  const unmatched = Object.keys(summary.unmatchedStaff);
  if (unmatched.length) {
    const staff = await sm8GetAll(apiKey, 'staff').catch(() => []);
    const nameOf = new Map(staff.map(s => [s.uuid, `${s.first || ''} ${s.last || ''}`.trim()]));
    summary.unmatchedStaff = Object.fromEntries(unmatched.map(u => [nameOf.get(u) || 'Unknown ServiceM8 staff', summary.unmatchedStaff[u]]));
  }
  return summary;
}

module.exports = { copyLabourAndChecklists, sm8DateToIso };
