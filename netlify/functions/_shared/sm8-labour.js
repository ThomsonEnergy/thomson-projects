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
// Lettered jobs (4515A deposit, 4515B claim...) are part of the main job
// (see sm8-import.js), and staff often check in, tick checklists and take
// photos on them, so everything on 4515A-D lands on 4515 too.
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

// ServiceM8 shows a job's checklist in named groups ("Checklist", "Things
// to confirm with Matt"), each a list of items. Here each group becomes a
// task and its items its subtasks. ServiceM8's API docs don't name the
// group field, so the first of these that an item carries is used; an item
// with none goes under a "Checklist" task. If the group value is another
// item's uuid, that item is the group's heading and becomes the task.
const GROUP_NAME_FIELDS = ['checklist_group_name', 'group_name', 'checklist_group', 'group', 'heading', 'section', 'category', 'checklist_name'];
const GROUP_UUID_FIELDS = ['checklist_group_uuid', 'group_uuid', 'parent_uuid', 'parent_checklist_uuid'];
const isUuidLike = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '').trim());
function groupOf(item) {
  for (const f of GROUP_UUID_FIELDS) if (isUuidLike(item[f])) return { key: String(item[f]).toLowerCase(), name: GROUP_NAME_FIELDS.map(n => clean(item[n])).find(v => v && !isUuidLike(v)) || null };
  for (const f of GROUP_NAME_FIELDS) {
    const v = clean(item[f]);
    if (v && isUuidLike(v)) return { key: v.toLowerCase(), name: null };
    if (v) return { key: `name:${v.toLowerCase()}`, name: v };
  }
  return { key: 'name:checklist', name: 'Checklist' };
}

async function copyJobChecklist(supabaseAdmin, userId, project, items, profileByStaff, summary) {
  const { data: existing, error } = await supabaseAdmin.from('job_tasks')
    .select('id, completed, parent_task_id, sm8_checklist_uuid').eq('project_id', project.id).not('sm8_checklist_uuid', 'is', null);
  if (error) throw error;
  const existingByUuid = new Map((existing || []).map(t => [t.sm8_checklist_uuid, t]));
  const byUuid = new Map(items.map(i => [String(i.uuid).toLowerCase(), i]));
  const sorted = items.slice().sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));

  // Group the items. A group whose key is an item's own uuid is headed by
  // that item; others get a task named after the group (or "Checklist").
  const groups = new Map();
  const headingUuids = new Set();
  for (const item of sorted) {
    const g = groupOf(item);
    if (byUuid.has(g.key)) headingUuids.add(g.key);
    if (!groups.has(g.key)) groups.set(g.key, { key: g.key, name: g.name, items: [] });
    groups.get(g.key).items.push(item);
  }
  // A heading item belongs to no group of its own.
  for (const g of groups.values()) g.items = g.items.filter(i => !headingUuids.has(String(i.uuid).toLowerCase()));

  const itemFields = (item) => {
    const completedAt = sm8DateToIso(item.completed_timestamp);
    const createdAt = sm8DateToIso(item.create_date) || sm8DateToIso(item.timestamp);
    const fields = {
      completed: !!completedAt,
      completed_at: completedAt,
      completed_by: completedAt ? profileByStaff.get(item.completed_by_staff_uuid) || null : null,
      created_by: profileByStaff.get(item.created_by_staff_uuid) || userId,
    };
    if (createdAt) fields.created_at = createdAt;
    // The Sydney date as ServiceM8 shows it (not the UTC one).
    const due = [item.reminder_date, item.due_date].map(d => String(d || '').slice(0, 10)).find(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d !== '0000-00-00');
    if (due && !completedAt) fields.due_date = due;
    const assignee = profileByStaff.get(item.reminder_staff_uuid) || profileByStaff.get(item.assigned_to_staff_uuid);
    if (assignee && !completedAt) fields.assigned_to_user_id = assignee;
    return fields;
  };

  // Insert or update one task; returns its id.
  async function upsertTask(sm8Uuid, row, isItem) {
    const had = existingByUuid.get(sm8Uuid);
    if (had) {
      // Grouped once (tasks copied before grouping existed); after that a
      // task someone moved stays where they put it.
      const fields = had.parent_task_id ? {} : { parent_task_id: row.parent_task_id ?? null };
      // Ticked in ServiceM8 since the last run: tick it here too.
      if (row.completed && !had.completed) { Object.assign(fields, { completed: true, completed_at: row.completed_at, completed_by: row.completed_by }); if (isItem) summary.checklistTicked++; }
      else if (isItem) summary.checklistAlready++;
      if (row.created_at) fields.created_at = row.created_at;
      if (row.created_by) fields.created_by = row.created_by;
      const { error: upErr } = await supabaseAdmin.from('job_tasks').update(fields).eq('id', had.id);
      if (upErr) throw upErr;
      return had.id;
    }
    const { data, error: insErr } = await supabaseAdmin.from('job_tasks')
      .insert({ project_id: project.id, task_type: 'onsite', notes: 'From the ServiceM8 checklist', sm8_checklist_uuid: sm8Uuid, ...row })
      .select('id').single();
    if (insErr) throw insErr;
    if (isItem) summary.checklistAdded++;
    return data.id;
  }

  let groupOrder = 0;
  for (const g of groups.values()) {
    if (!g.items.length && !headingUuids.has(g.key)) continue;
    groupOrder++;
    const heading = byUuid.get(g.key);
    const subs = g.items.filter(i => clean(i.name));
    const allDone = subs.length > 0 && subs.every(i => sm8DateToIso(i.completed_timestamp));
    const lastDone = allDone ? subs.map(i => sm8DateToIso(i.completed_timestamp)).sort().pop() : null;
    const parentRow = {
      description: clean(heading && heading.name) || g.name || 'Checklist',
      sort_order: groupOrder,
      parent_task_id: null,
      completed: allDone,
      completed_at: lastDone,
      completed_by: null,
      ...(heading ? (({ completed, completed_at, completed_by, ...rest }) => rest)(itemFields(heading)) : { created_by: userId }),
    };
    if (!subs.length && heading) Object.assign(parentRow, itemFields(heading));
    // A task can't be ticked while a subtask is open (database rule), so an
    // existing group task is ticked after its subtasks, not before.
    const parentUuid = heading ? heading.uuid : `group:${project.sm8_job_uuid}:${g.key}`;
    const parentExists = existingByUuid.has(parentUuid);
    const parentId = await upsertTask(parentUuid, parentExists && subs.length ? { ...parentRow, completed: false } : parentRow, !!heading);
    let subOrder = 0;
    for (const item of subs) {
      subOrder++;
      await upsertTask(item.uuid, { description: clean(item.name), sort_order: subOrder, parent_task_id: parentId, ...itemFields(item) }, true);
    }
    if (parentExists && allDone) {
      await supabaseAdmin.from('job_tasks').update({ completed: true, completed_at: lastDone, completed_by: null }).eq('id', parentId).eq('completed', false);
    }
  }
}

// Every ServiceM8 job uuid that belongs to each imported job: its own, plus
// its lettered jobs ("4515" -> 4515A, 4515b...). Same lookup as the import's
// dry run: one call per imported job for its date, then every job dated
// after the oldest ('gt', ServiceM8 has no 'ge'), since a lettered job is
// always made after its main job. Returns Map project id -> [uuids].
async function sm8JobGroups(apiKey, projects) {
  const groups = new Map(projects.map(p => [p.id, [p.sm8_job_uuid]]));
  if (!projects.length) return groups;
  const byNumber = new Map(projects.filter(p => p.sm8_job_number).map(p => [String(p.sm8_job_number).toLowerCase(), p.id]));
  const dates = [];
  for (const p of projects) {
    const [job] = await sm8GetAll(apiKey, 'job', `uuid eq '${p.sm8_job_uuid}'`);
    const d = String((job && job.date) || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d > '2000-01-01') dates.push(d);
    await sleep(350);
  }
  dates.sort();
  const since = new Date(new Date(`${dates[0] || '2015-01-02'}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
  const jobs = await sm8GetAll(apiKey, 'job', `active eq 1 and date gt '${since}'`);
  for (const j of jobs) {
    const m = String(j.generated_job_id || '').trim().match(/^(\d+)[a-z]+$/i);
    const projectId = m && byNumber.get(m[1].toLowerCase());
    if (projectId && !groups.get(projectId).includes(j.uuid)) groups.get(projectId).push(j.uuid);
  }
  return groups;
}

// summary is filled in place so the caller can save it even if this throws.
async function copyLabourAndChecklists(supabaseAdmin, apiKey, userId, summary, groups) {
  Object.assign(summary, {
    jobs: 0, letteredJobs: 0, jobErrors: [], activitiesSeen: 0, checklistSeen: 0,
    timeAdded: 0, timeAlready: 0, timeMoved: 0, timeSkippedUnmatched: 0, timeSkippedNoTimes: 0, unmatchedStaff: {},
    checklistAdded: 0, checklistAlready: 0, checklistTicked: 0,
  });

  const [{ data: projects, error }, { data: linked, error: linkErr }] = await Promise.all([
    supabaseAdmin.from('projects').select('id, job_number, quote_number, sm8_job_uuid, sm8_job_number, cost_centres(id)').not('sm8_job_uuid', 'is', null),
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
      const activities = [], items = [];
      const uuids = groups.get(project.id) || [project.sm8_job_uuid];
      summary.letteredJobs += uuids.length - 1;
      for (const uuid of uuids) {
        const [a, c] = await Promise.all([
          sm8GetAll(apiKey, 'jobactivity', `job_uuid eq '${uuid}' and active eq 1`),
          sm8GetAll(apiKey, 'jobchecklist', `job_uuid eq '${uuid}' and active eq 1`),
        ]);
        activities.push(...a);
        items.push(...c);
        await sleep(500);
      }
      summary.activitiesSeen += activities.length;
      // A few raw records kept in the run summary, to check ServiceM8's
      // field names against what this code expects.
      if (!summary.samples) summary.samples = { checklist: [], activity: [] };
      if (!summary.samples.checklist.length) summary.samples.checklist = items.slice(0, 6);
      if (!summary.samples.activity.length) summary.samples.activity = activities.slice(0, 2);
      summary.checklistSeen += items.length;
      // A job with one stage puts the time on it; otherwise it is left
      // unassigned to a stage, like a clock-in that picked none.
      const centreId = (project.cost_centres || []).length === 1 ? project.cost_centres[0].id : null;
      await copyJobLabour(supabaseAdmin, project, activities.filter(a => isOn(a.activity_was_recorded)), profileByStaff, centreId, summary);
      await copyJobChecklist(supabaseAdmin, userId, project, items, profileByStaff, summary);
      summary.jobs++;
    } catch (err) {
      console.error('sm8-labour job error:', project.sm8_job_uuid, err.message);
      summary.jobErrors.push({ jobNumber: project.job_number, ref: project.job_number ? `J${project.job_number}` : `Q${project.quote_number}`, error: String(err.message).slice(0, 300) });
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

module.exports = { copyLabourAndChecklists, copyJobChecklist, sm8JobGroups, sm8DateToIso };
