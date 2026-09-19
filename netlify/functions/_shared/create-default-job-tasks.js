// Called from create-job-from-quote.js right after a job's cost centres
// are copied over from its source quote. Only does anything for a solar
// job (proposal_template === 'solar') - other templates don't have this
// checklist.
//
// Inserts two batches of job_tasks:
//  - prejob (before install): one "order <gear>" task per item Pylon has
//    designed for this job, using the description straight from Pylon -
//    no AI needed here, it's a direct 1:1 template, and using the real
//    description means it can't be wrong about which panel/inverter/
//    battery is meant.
//  - handover (after install): whatever the deterministic compliance
//    rules in _shared/solar-compliance-rules.js say is still missing at
//    the moment the job is created (almost everything, since none of the
//    install-time fields exist yet), worded into specific task text by
//    _shared/word-solar-tasks.js the same way the quote-page checklist
//    does it.
//
// Best-effort: if the AI wording step fails (e.g. no Anthropic key set
// yet), falls back to the plain rule labels rather than blocking job
// creation - a less polished task list is far better than none at all.

const { evaluate } = require('./solar-compliance-rules');
const { wordSolarTasks } = require('./word-solar-tasks');

async function createDefaultJobTasks(supabaseAdmin, job, newStages) {
  if (job.proposal_template !== 'solar') return;

  const pylonData = job.pylon_data || {};
  const equipment = {
    panels: pylonData.module_types || [],
    inverters: pylonData.inverter_types || [],
    batteries: pylonData.storage_types || [],
  };

  const rows = [];

  ['panels', 'inverters', 'batteries'].forEach((kind) => {
    equipment[kind].forEach((item) => {
      const description = item?.description || null;
      if (!description) return;
      rows.push({
        project_id: job.id,
        description: `Order ${description}`,
        task_type: 'prejob',
        required_before_scheduling: true,
      });
    });
  });

  const { data: licences } = await supabaseAdmin
    .from('profile_licences')
    .select('licence_name, profiles!inner(active)')
    .eq('profiles.active', true);

  const solarCentres = (newStages || []).filter((c) => c.stc_system_kw != null || c.stc_total != null);
  const ctx = {
    project: job,
    equipment,
    solarCentres,
    quotedTotal: (newStages || []).reduce((s, c) => s + (Number(c.quoted_amount) || 0), 0),
    hasAccreditedStaff:
      (licences || []).some((l) => /saa|accreditation/i.test(l.licence_name || '')) &&
      (licences || []).some((l) => /electrical/i.test(l.licence_name || '')),
    hasComplianceCertDoc: false, // no documents exist yet on a job this fresh
    hasOwnerDeclarationDoc: false,
  };
  const handoverMissing = evaluate('handover', ctx).filter((r) => !r.met);

  if (handoverMissing.length) {
    let worded;
    try {
      worded = await wordSolarTasks({ missing: handoverMissing, equipment });
    } catch (err) {
      console.error('Solar task wording failed, falling back to plain labels:', err.message);
      worded = handoverMissing.map((m) => ({ id: m.id, description: m.label }));
    }
    worded.forEach((t) => {
      rows.push({
        project_id: job.id,
        description: t.description,
        task_type: 'handover',
        required_before_scheduling: false,
      });
    });
  }

  if (!rows.length) return;

  const { error } = await supabaseAdmin.from('job_tasks').insert(rows);
  if (error) console.error('Failed to insert default solar job tasks:', error.message);
}

module.exports = { createDefaultJobTasks };
