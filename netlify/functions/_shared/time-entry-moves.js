// Moving clocked shifts (time_entries) to the right job, stage or non-job category (backlog item 42).
// Called by admin-update-time-entry.js (the job page Time tab, Admin only). Hours, dates and pay never
// change here, so Xero payroll is untouched: only which job and stage carry the cost.
// Checks: every stage sent belongs to the target job; a shift still clocked in cannot move; a shift
// already billed on an invoice line (invoice_line_items.time_entry_ids, the same rule create-invoice
// uses) cannot leave its job. Writes time_entries and one activity_log line per job touched.

const SYD = 'Australia/Sydney';
const jobLabel = (p) => (p ? (p.job_number ? `J${p.job_number}` : p.quote_number ? `Q${p.quote_number}` : p.name || 'a job') : 'non-job time');
const sydDate = (iso) => new Date(iso).toLocaleDateString('en-AU', { timeZone: SYD, day: 'numeric', month: 'short' });
const paidHours = (e) => (e.clock_out ? Math.max(0, (new Date(e.clock_out) - new Date(e.clock_in)) / 3600000 - Number(e.break_minutes || 0) / 60) : 0);
const fmtH = (h) => `${Math.round(h * 100) / 100}h`;

// One stage goes on cost_centre_id, several (a split shift) on selected_cost_centre_ids, the way the
// clock-out and Timesheets store it (entryCentreIds in compute-labour-cost.js reads it back).
function stagePatch(stageIds) {
  return { cost_centre_id: stageIds.length === 1 ? stageIds[0] : null, selected_cost_centre_ids: stageIds.length > 1 ? stageIds : null };
}

// The stages must all be on that job. Returns an error message or null.
async function checkStages(admin, projectId, stageIds) {
  if (!stageIds.length) return null;
  const { data, error } = await admin.from('cost_centres').select('id').eq('project_id', projectId).in('id', stageIds);
  if (error) throw error;
  return (data || []).length === stageIds.length ? null : 'One of the stages picked is not on that job. Pick the stages again.';
}

// Billed shifts among the ids: { entryId: 'SI3012' }.
async function billedOn(admin, entryIds) {
  if (!entryIds.length) return {};
  const { data, error } = await admin.from('invoice_line_items').select('time_entry_ids, invoices(invoice_number)').overlaps('time_entry_ids', entryIds);
  if (error) throw error;
  const out = {};
  for (const row of data || []) for (const id of row.time_entry_ids || []) if (entryIds.includes(id)) out[id] = row.invoices?.invoice_number || 'an invoice';
  return out;
}

// entryIds: shifts to move. projectId: the job they belong on (null with a non-job category).
// stageIds: stages on that job (one or more) when category is 'job'.
async function moveTimeEntries(admin, { entryIds, projectId, stageIds, category, userId }) {
  const ids = [...new Set((entryIds || []).filter(Boolean))];
  const stages = [...new Set((stageIds || []).filter(Boolean))];
  const cat = category || 'job';
  if (!ids.length) return { ok: false, error: 'Pick at least one shift.' };
  // A clocked shift can be job time or one of the clocked non-job kinds (TAFE is a fixed day, made in Timesheets).
  if (!['job', 'quoting', 'admin', 'maintenance', 'training'].includes(cat)) return { ok: false, error: 'Pick a job or a non-job category.' };
  if (cat === 'job' && !projectId) return { ok: false, error: 'Pick the job they belong on.' };
  if (cat === 'job' && !stages.length) return { ok: false, error: 'Tick at least one stage on that job, or choose a non-job category.' };

  const { data: entries, error } = await admin.from('time_entries')
    .select('id, project_id, clock_in, clock_out, break_minutes, profiles(full_name), projects(id, name, job_number, quote_number)').in('id', ids);
  if (error) throw error;
  if ((entries || []).length !== ids.length) return { ok: false, error: 'One of those shifts was not found. Reload the page.' };
  if (entries.some((e) => !e.clock_out)) return { ok: false, error: 'A shift that is still clocked in cannot be moved. Clock it out first.' };

  let target = null;
  if (cat === 'job') {
    const { data: p, error: pErr } = await admin.from('projects').select('id, name, job_number, quote_number').eq('id', projectId).maybeSingle();
    if (pErr) throw pErr;
    if (!p) return { ok: false, error: 'That job was not found.' };
    target = p;
    const bad = await checkStages(admin, projectId, stages);
    if (bad) return { ok: false, error: bad };
  }

  const leaving = entries.filter((e) => e.project_id && e.project_id !== (target ? target.id : null));
  const billed = await billedOn(admin, leaving.map((e) => e.id));
  const billedIds = Object.keys(billed);
  if (billedIds.length) {
    const e = entries.find((x) => x.id === billedIds[0]);
    return { ok: false, error: `${e.profiles?.full_name || 'This'}'s shift on ${sydDate(e.clock_in)} is billed on ${billed[e.id]}, so it stays on ${jobLabel(e.projects)}. Fix or credit that invoice first.` };
  }

  const { error: upErr } = await admin.from('time_entries').update({
    project_id: target ? target.id : null,
    time_category: cat,
    ...(cat === 'job' ? stagePatch(stages) : { cost_centre_id: null, selected_cost_centre_ids: null }),
  }).in('id', ids);
  if (upErr) throw upErr;

  // One activity line per shift that changed job, on both jobs.
  const logs = [];
  for (const e of leaving.concat(entries.filter((x) => !x.project_id && target))) {
    const text = `Moved ${e.profiles?.full_name || 'a'}'s ${fmtH(paidHours(e))} on ${sydDate(e.clock_in)} from ${jobLabel(e.projects)} to ${target ? jobLabel(target) : `${cat} time`}`;
    if (e.project_id) logs.push({ entity_type: 'project', entity_id: e.project_id, action: 'time_moved', description: text, changed_by: userId });
    if (target) logs.push({ entity_type: 'project', entity_id: target.id, action: 'time_moved', description: text, changed_by: userId });
  }
  if (logs.length) {
    const { error: logErr } = await admin.from('activity_log').insert(logs);
    if (logErr) console.error('time move activity log failed:', logErr.message); // the move itself is done
  }
  return { ok: true, moved: ids.length };
}

module.exports = { moveTimeEntries, checkStages, stagePatch, billedOn };
