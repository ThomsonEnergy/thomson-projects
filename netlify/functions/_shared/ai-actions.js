// Things the AI assistant can do for staff: create / change tasks and book /
// move / remove people on the Schedule.
//
// The assistant never does any of this itself. When it wants to, it calls one of
// the tools below, which only PREPARES the change (works out who and which job,
// checks it makes sense, writes a plain-English summary). The chat shows that
// summary with a Confirm button, and only when a person presses it does
// ai-run-action.js call execute() here. Both steps run as the signed-in person
// (their own token, so the database rules apply exactly as in the app: anyone
// can make tasks, only admin / finance / sales can change the Schedule).

const TASK_TYPES = ['prejob', 'onsite', 'handover', 'quote'];
const BLOCK_KINDS = ['job', 'site_visit', 'office', 'training', 'other'];
const KIND_LABEL = { job: 'on the job', site_visit: 'for a site visit', office: 'office / admin', training: 'training', other: 'other' };

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const fmtDay = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const hhmm = (t) => String(t || '').slice(0, 5);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const jobLabel = (p) => (p.job_number ? `J${p.job_number}` : p.quote_number ? `Q${p.quote_number}` : '') + (p.name ? ` - ${p.name}` : '');

// ---------- lookups ----------
async function resolveStaff(client, { id, name }, what = 'person') {
  if (id) {
    if (!isUuid(id)) return { error: `"${id}" is not a valid ${what} id.` };
    const { data } = await client.from('profiles').select('id, full_name, active').eq('id', id).maybeSingle();
    if (!data || data.active === false) return { error: `That ${what} is not an active staff member.` };
    return { id: data.id, name: data.full_name || 'Unnamed' };
  }
  const wanted = norm(name);
  if (!wanted) return { error: `Which ${what}? A name is needed.` };
  const { data } = await client.from('profiles').select('id, full_name, active').eq('active', true);
  const people = (data || []).filter(p => p.full_name);
  const exact = people.filter(p => norm(p.full_name) === wanted);
  if (exact.length === 1) return { id: exact[0].id, name: exact[0].full_name };
  const tokens = wanted.split(' ');
  const hits = people.filter(p => tokens.every(t => norm(p.full_name).split(' ').some(w => w.startsWith(t))));
  if (hits.length === 1) return { id: hits[0].id, name: hits[0].full_name };
  if (!hits.length) return { error: `No active staff member matches "${name}".` };
  return { error: `More than one staff member matches "${name}": ${hits.map(h => h.full_name).join(', ')}. Ask which one is meant.` };
}

async function resolveJob(client, { id, text }) {
  if (id) {
    if (!isUuid(id)) return { error: `"${id}" is not a valid job id.` };
    const { data } = await client.from('projects').select('id, name, job_number, quote_number').eq('id', id).maybeSingle();
    return data ? { project: data } : { error: 'That job was not found.' };
  }
  const q = String(text || '').trim();
  if (!q) return { project: null };
  const m = q.match(/^([jq])?\s*#?(\d{1,7})$/i);
  let rows = [];
  if (m) {
    const col = (m[1] || 'j').toLowerCase() === 'q' ? 'quote_number' : 'job_number';
    ({ data: rows } = await client.from('projects').select('id, name, job_number, quote_number').eq(col, Number(m[2])));
    if (!(rows || []).length && !m[1]) ({ data: rows } = await client.from('projects').select('id, name, job_number, quote_number').eq('quote_number', Number(m[2])));
  } else {
    const safe = q.replace(/[%,()]/g, ' ');
    ({ data: rows } = await client.from('projects').select('id, name, job_number, quote_number, client_name')
      .or(`name.ilike.%${safe}%,client_name.ilike.%${safe}%,client_address.ilike.%${safe}%`).order('created_at', { ascending: false }).limit(6));
  }
  if (!(rows || []).length) return { error: `No job found for "${q}".` };
  if (rows.length > 1) return { error: `More than one job matches "${q}": ${rows.map(jobLabel).join('; ')}. Ask which one is meant.` };
  return { project: rows[0] };
}

async function bookingsOn(client, staffId, date, exceptId) {
  const { data } = await client.from('schedule_assignments').select('id, start_time, end_time, note, block_type, projects(name, job_number, quote_number)')
    .eq('staff_id', staffId).eq('assignment_date', date);
  return (data || []).filter(a => a.id !== exceptId);
}
const overlaps = (a, b) => hhmm(a.start_time) < hhmm(b.end_time) && hhmm(b.start_time) < hhmm(a.end_time);
const describeBooking = (a) => `${hhmm(a.start_time)}-${hhmm(a.end_time)} ${a.projects ? jobLabel(a.projects) : (a.note || KIND_LABEL[a.block_type] || 'booking')}`;

// ---------- prepare: check + describe one action (no changes made) ----------
async function prepare(client, type, input) {
  input = input || {};
  const warnings = [];
  try {
    if (type === 'create_task') {
      const description = String(input.description || '').trim();
      if (!description) return { ok: false, error: 'The task needs a description.' };
      if (description.length > 200) return { ok: false, error: 'Keep the task description under 200 characters.' };
      if (input.due_date && !isDate(input.due_date)) return { ok: false, error: 'due_date must be a real date like 2026-10-15.' };
      const recurrence = input.recurrence || null;
      if (recurrence && !['daily', 'weekly', 'monthly'].includes(recurrence)) return { ok: false, error: 'recurrence must be daily, weekly or monthly.' };
      if (recurrence && !input.due_date) return { ok: false, error: 'A repeating task needs a first due date to count forward from.' };
      const taskType = input.task_type && TASK_TYPES.includes(input.task_type) ? input.task_type : 'prejob';
      let assignee = null;
      if (input.assignee_id || input.assignee_name) { assignee = await resolveStaff(client, { id: input.assignee_id, name: input.assignee_name }, 'assignee'); if (assignee.error) return { ok: false, error: assignee.error }; }
      let project = null;
      if (input.project_id || input.job) { const r = await resolveJob(client, { id: input.project_id, text: input.job }); if (r.error) return { ok: false, error: r.error }; project = r.project; }
      if (recurrence) warnings.push(`It repeats ${recurrence}: the next one is created when this one is ticked off.`);
      return {
        ok: true, type,
        params: { description, assignee_id: assignee && assignee.id, assignee_name: assignee && assignee.name, project_id: project && project.id, due_date: input.due_date || null, recurrence, task_type: taskType },
        summary: `Create the task "${description}"${assignee ? ` for ${assignee.name}` : ' (unassigned, anyone can pick it up)'}${project ? ` on ${jobLabel(project)}` : ''}${input.due_date ? `, due ${fmtDay(input.due_date)}` : ''}${recurrence ? `, repeating ${recurrence}` : ''}`,
        warnings,
      };
    }

    if (type === 'update_task') {
      if (!isUuid(input.task_id)) return { ok: false, error: 'task_id must be the id of an existing task (look it up first).' };
      const { data: task } = await client.from('job_tasks').select('id, description, completed, assigned_to_user_id, due_date, project_id').eq('id', input.task_id).maybeSingle();
      if (!task) return { ok: false, error: 'That task was not found.' };
      const changes = {}; const bits = [];
      if (input.description !== undefined) { const d = String(input.description).trim(); if (!d || d.length > 200) return { ok: false, error: 'description must be 1 to 200 characters.' }; changes.description = d; bits.push(`rename it to "${d}"`); }
      if (input.assignee_id || input.assignee_name) { const a = await resolveStaff(client, { id: input.assignee_id, name: input.assignee_name }, 'assignee'); if (a.error) return { ok: false, error: a.error }; changes.assigned_to_user_id = a.id; changes.assignee_name = a.name; bits.push(`give it to ${a.name}`); }
      if (input.due_date !== undefined) { if (input.due_date === null || input.due_date === 'none') { changes.due_date = null; bits.push('clear the due date'); } else { if (!isDate(input.due_date)) return { ok: false, error: 'due_date must be a real date like 2026-10-15.' }; changes.due_date = input.due_date; bits.push(`set it due ${fmtDay(input.due_date)}`); } }
      if (input.completed !== undefined) { changes.completed = !!input.completed; bits.push(input.completed ? 'mark it done' : 'reopen it'); }
      if (!bits.length) return { ok: false, error: 'Nothing to change: give a new description, assignee, due date or completed.' };
      return { ok: true, type, params: { task_id: task.id, ...changes }, summary: `On the task "${task.description}": ${bits.join(', ')}`, warnings };
    }

    if (type === 'book_staff') {
      const staff = await resolveStaff(client, { id: input.staff_id, name: input.staff_name }, 'person');
      if (staff.error) return { ok: false, error: staff.error };
      if (!isDate(input.date)) return { ok: false, error: 'date must be a real date like 2026-10-15.' };
      const start = input.start_time || '07:00', end = input.end_time || '15:30';
      if (!isTime(start) || !isTime(end) || start >= end) return { ok: false, error: 'start_time and end_time must be like 07:00 and 15:30, with the end after the start.' };
      let project = null;
      if (input.project_id || input.job) { const r = await resolveJob(client, { id: input.project_id, text: input.job }); if (r.error) return { ok: false, error: r.error }; project = r.project; }
      const kind = input.kind && BLOCK_KINDS.includes(input.kind) ? input.kind : (project ? 'job' : 'office');
      if ((kind === 'job' || kind === 'site_visit') && !project) return { ok: false, error: `A ${kind === 'job' ? 'job booking' : 'site visit'} needs a job. Which job?` };
      if (kind === 'job' && project) {
        const { data: blockers } = await client.from('job_tasks').select('description').eq('project_id', project.id).eq('required_before_scheduling', true).eq('completed', false);
        if ((blockers || []).length) return { ok: false, error: `${jobLabel(project)} cannot be scheduled yet, these tasks are required first: ${blockers.map(b => b.description).join('; ')}.` };
      }
      const clash = (await bookingsOn(client, staff.id, input.date)).filter(a => overlaps(a, { start_time: start, end_time: end }));
      if (clash.length) warnings.push(`${staff.name} already has: ${clash.map(describeBooking).join('; ')} at that time.`);
      const note = input.note ? String(input.note).trim().slice(0, 200) : null;
      return {
        ok: true, type,
        params: { staff_id: staff.id, staff_name: staff.name, project_id: project && project.id, date: input.date, start_time: start, end_time: end, kind, note },
        summary: `Book ${staff.name} ${project ? `${KIND_LABEL[kind] === 'on the job' ? 'on' : 'for'} ${jobLabel(project)}` : KIND_LABEL[kind]} on ${fmtDay(input.date)}, ${start} to ${end}${!project && note ? ` (${note})` : ''}`,
        warnings,
      };
    }

    if (type === 'move_booking' || type === 'remove_booking') {
      if (!isUuid(input.assignment_id)) return { ok: false, error: 'assignment_id must be the id of an existing booking (look it up in schedule_assignments first).' };
      const { data: a } = await client.from('schedule_assignments').select('id, staff_id, assignment_date, start_time, end_time, note, block_type, projects(name, job_number, quote_number)').eq('id', input.assignment_id).maybeSingle();
      if (!a) return { ok: false, error: 'That booking was not found.' };
      const { data: who } = await client.from('profiles').select('full_name').eq('id', a.staff_id).maybeSingle();
      const label = a.projects ? jobLabel(a.projects) : (a.note || KIND_LABEL[a.block_type] || 'booking');
      if (type === 'remove_booking') {
        return { ok: true, type, destructive: true, params: { assignment_id: a.id }, summary: `Remove ${who ? who.full_name + "'s" : 'their'} booking for ${label} on ${fmtDay(a.assignment_date)}, ${hhmm(a.start_time)} to ${hhmm(a.end_time)}`, warnings };
      }
      const changes = {}; const bits = [];
      let newStaff = { id: a.staff_id, name: who ? who.full_name : 'them' };
      if (input.staff_id || input.staff_name) { const s = await resolveStaff(client, { id: input.staff_id, name: input.staff_name }, 'person'); if (s.error) return { ok: false, error: s.error }; newStaff = s; changes.staff_id = s.id; bits.push(`move it to ${s.name}`); }
      let date = a.assignment_date, start = hhmm(a.start_time), end = hhmm(a.end_time);
      if (input.date) { if (!isDate(input.date)) return { ok: false, error: 'date must be a real date like 2026-10-15.' }; date = input.date; changes.assignment_date = date; bits.push(`move it to ${fmtDay(date)}`); }
      if (input.start_time) { if (!isTime(input.start_time)) return { ok: false, error: 'start_time must be like 07:00.' }; start = input.start_time; changes.start_time = start; bits.push(`start at ${start}`); }
      if (input.end_time) { if (!isTime(input.end_time)) return { ok: false, error: 'end_time must be like 15:30.' }; end = input.end_time; changes.end_time = end; bits.push(`finish at ${end}`); }
      if (!bits.length) return { ok: false, error: 'Nothing to change: give a new date, start_time, end_time or staff.' };
      if (start >= end) return { ok: false, error: 'The end time must be after the start time.' };
      const clash = (await bookingsOn(client, newStaff.id, date, a.id)).filter(x => overlaps(x, { start_time: start, end_time: end }));
      if (clash.length) warnings.push(`${newStaff.name} already has: ${clash.map(describeBooking).join('; ')} at that time.`);
      return { ok: true, type, params: { assignment_id: a.id, ...changes }, summary: `For ${who ? who.full_name + "'s" : 'their'} booking on ${label} (${fmtDay(a.assignment_date)}, ${hhmm(a.start_time)} to ${hhmm(a.end_time)}): ${bits.join(', ')}`, warnings };
    }

    return { ok: false, error: `Unknown action "${type}".` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- execute: do it (re-checks first) ----------
const permissionMessage = (err) => (err && (err.code === '42501' || /row-level security|permission denied/i.test(err.message || ''))
  ? 'You do not have permission to do that. Changing the Schedule is for admin, finance and sales.'
  : (err && err.message) || 'Something went wrong.');

async function execute(client, userId, type, params) {
  const input = { ...(params || {}) };
  // A proposal's params hold the resolved ids; map them back onto what prepare()
  // takes so everything is checked again, by id, at the moment it is confirmed.
  let again;
  if (type === 'book_staff') again = { staff_id: input.staff_id, project_id: input.project_id, date: input.date, start_time: input.start_time, end_time: input.end_time, kind: input.kind, note: input.note };
  else if (type === 'create_task') again = { description: input.description, assignee_id: input.assignee_id, project_id: input.project_id, due_date: input.due_date, recurrence: input.recurrence, task_type: input.task_type };
  else if (type === 'update_task') {
    again = { task_id: input.task_id };
    if ('description' in input) again.description = input.description;
    if ('assigned_to_user_id' in input) again.assignee_id = input.assigned_to_user_id;
    if ('due_date' in input) again.due_date = input.due_date === null ? 'none' : input.due_date;
    if ('completed' in input) again.completed = input.completed;
  } else if (type === 'move_booking') {
    again = { assignment_id: input.assignment_id };
    if ('staff_id' in input) again.staff_id = input.staff_id;
    if ('assignment_date' in input) again.date = input.assignment_date;
    if ('start_time' in input) again.start_time = input.start_time;
    if ('end_time' in input) again.end_time = input.end_time;
  } else again = { assignment_id: input.assignment_id };
  const prepared = await prepare(client, type, again);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const p = prepared.params;

  const logActivity = async (projectId, action, description) => {
    if (!projectId) return;
    try { await client.from('activity_log').insert({ entity_type: 'project', entity_id: projectId, action, description: `${description} (by the AI assistant, confirmed by a staff member)`, changed_by: userId }); } catch (e) { /* never block the action */ }
  };

  if (type === 'create_task') {
    const { error } = await client.from('job_tasks').insert({
      project_id: p.project_id || null, description: p.description, task_type: p.task_type, assigned_to_user_id: p.assignee_id || null,
      due_date: p.due_date || null, recurrence: p.recurrence || null, created_by: userId,
    });
    if (error) return { ok: false, error: permissionMessage(error) };
    await logActivity(p.project_id, 'task_added', `Task added: ${p.description}${p.assignee_name ? ` (assigned to ${p.assignee_name})` : ''}`);
    return { ok: true, message: `Done. Task created${p.assignee_name ? ` for ${p.assignee_name}` : ''}.` };
  }

  if (type === 'update_task') {
    const fields = {};
    ['description', 'assigned_to_user_id', 'due_date'].forEach(k => { if (k in p) fields[k] = p[k]; });
    if ('completed' in p) { fields.completed = p.completed; fields.completed_by = p.completed ? userId : null; fields.completed_at = p.completed ? new Date().toISOString() : null; }
    const { error } = await client.from('job_tasks').update(fields).eq('id', p.task_id);
    if (error) return { ok: false, error: permissionMessage(error) };
    return { ok: true, message: 'Done. Task updated.' };
  }

  if (type === 'book_staff') {
    const { error } = await client.from('schedule_assignments').insert({
      staff_id: p.staff_id, project_id: p.project_id || null, block_type: p.kind, assignment_date: p.date, start_time: p.start_time, end_time: p.end_time,
      note: p.project_id ? null : (p.note || null),
    });
    if (error) return { ok: false, error: permissionMessage(error) };
    await logActivity(p.project_id, 'schedule_added', `${p.staff_name} booked on ${fmtDay(p.date)}, ${p.start_time} to ${p.end_time}`);
    return { ok: true, message: `Done. ${p.staff_name} is booked on ${fmtDay(p.date)}.` };
  }

  if (type === 'move_booking') {
    const fields = {};
    ['staff_id', 'assignment_date', 'start_time', 'end_time'].forEach(k => { if (k in p) fields[k] = p[k]; });
    const { error } = await client.from('schedule_assignments').update(fields).eq('id', p.assignment_id);
    if (error) return { ok: false, error: permissionMessage(error) };
    return { ok: true, message: 'Done. Booking updated.' };
  }

  if (type === 'remove_booking') {
    const { error } = await client.from('schedule_assignments').delete().eq('id', p.assignment_id);
    if (error) return { ok: false, error: permissionMessage(error) };
    return { ok: true, message: 'Done. Booking removed.' };
  }
  return { ok: false, error: `Unknown action "${type}".` };
}

// ---------- tool definitions the model sees ----------
const PROPOSE_NOTE = ' This only PROPOSES the change: the person sees a summary with a Confirm button and nothing happens until they press it. Never say it is done.';
const ACTION_TOOLS = [
  {
    name: 'create_task',
    description: 'Propose creating a task (e.g. "take the bins out" for Casey every Wednesday). Optional assignee, job and due date; set recurrence for repeating chores (the first due_date must be the first occurrence).' + PROPOSE_NOTE,
    input_schema: { type: 'object', properties: {
      description: { type: 'string' }, assignee_name: { type: 'string', description: 'Staff member name, e.g. "Casey".' },
      job: { type: 'string', description: 'Job or quote number (e.g. 7004, J7004, Q1002) or words from its name/client. Leave out for an office / general task.' },
      due_date: { type: 'string', description: 'YYYY-MM-DD' }, recurrence: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
      task_type: { type: 'string', enum: ['prejob', 'onsite', 'handover'] },
    }, required: ['description'] },
  },
  {
    name: 'update_task',
    description: 'Propose changing an existing task: rename it, give it to someone, change or clear its due date, or mark it done / reopen it. Look up its id in job_tasks first.' + PROPOSE_NOTE,
    input_schema: { type: 'object', properties: {
      task_id: { type: 'string' }, description: { type: 'string' }, assignee_name: { type: 'string' },
      due_date: { type: 'string', description: 'YYYY-MM-DD, or "none" to clear.' }, completed: { type: 'boolean' },
    }, required: ['task_id'] },
  },
  {
    name: 'book_staff',
    description: 'Propose booking a person onto the Schedule for a day: on a job, a site visit, or office / training / other time. Defaults to 07:00 to 15:30. Only admin, finance and sales can change the Schedule.' + PROPOSE_NOTE,
    input_schema: { type: 'object', properties: {
      staff_name: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, start_time: { type: 'string', description: 'HH:MM 24 hour' }, end_time: { type: 'string', description: 'HH:MM 24 hour' },
      job: { type: 'string', description: 'Job number or words from its name/client. Needed for job and site_visit bookings.' },
      kind: { type: 'string', enum: BLOCK_KINDS }, note: { type: 'string', description: 'Label for office / training / other bookings.' },
    }, required: ['staff_name', 'date'] },
  },
  {
    name: 'move_booking',
    description: 'Propose changing an existing Schedule booking: a different day, times, or person. Look up its id in schedule_assignments first.' + PROPOSE_NOTE,
    input_schema: { type: 'object', properties: {
      assignment_id: { type: 'string' }, date: { type: 'string' }, start_time: { type: 'string' }, end_time: { type: 'string' }, staff_name: { type: 'string' },
    }, required: ['assignment_id'] },
  },
  {
    name: 'remove_booking',
    description: 'Propose removing a Schedule booking. Look up its id in schedule_assignments first.' + PROPOSE_NOTE,
    input_schema: { type: 'object', properties: { assignment_id: { type: 'string' } }, required: ['assignment_id'] },
  },
];
const ACTION_TOOL_NAMES = ACTION_TOOLS.map(t => t.name);

module.exports = { prepare, execute, ACTION_TOOLS, ACTION_TOOL_NAMES, resolveStaff, resolveJob };
