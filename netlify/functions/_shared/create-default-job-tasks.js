// Called from create-job-from-quote.js right after a job's cost centres
// are copied over from its source quote. Does something for a solar job,
// a battery job, a solar job with Batteries as well (template_answers.
// with_battery), and a renovation / service work job (their tasks come
// from the quote's answers - see template-job-tasks.js).
//
// Inserts two batches of job_tasks:
//  - prejob (before install): one "order <gear>" task per item Pylon has
//    designed for this job, using the description straight from Pylon -
//    no AI needed here, it's a direct 1:1 template, and using the real
//    description means it can't be wrong about which panel/inverter/
//    battery is meant; plus the battery pre-job tasks from the answers.
//  - handover (after install): whatever the deterministic compliance
//    rules in _shared/solar-compliance-rules.js say is still missing at
//    the moment the job is created (almost everything, since none of the
//    install-time fields exist yet), worded into specific task text by
//    _shared/word-solar-tasks.js the same way the quote-page checklist
//    does it; plus the battery handover tasks.
//
// Best-effort: if the AI wording step fails (e.g. no Anthropic key set
// yet), falls back to the plain rule labels rather than blocking job
// creation - a less polished task list is far better than none at all.

const { evaluate } = require('./solar-compliance-rules');
const { wordSolarTasks } = require('./word-solar-tasks');
const { tasksFor } = require('./template-job-tasks');
const { quoteHasBattery } = require('../../../public/js/template-questions.js');

async function createDefaultJobTasks(supabaseAdmin, job, newStages) {
  const template = job.proposal_template;
  const answers = job.template_answers || {};
  if (template === 'renovation' || template === 'service_work') {
    const rows = tasksFor(template, answers).map((t) => ({ ...t, project_id: job.id }));
    if (!rows.length) return;
    const { error } = await supabaseAdmin.from('job_tasks').insert(rows);
    if (error) console.error('Failed to insert default job tasks:', error.message);
    return;
  }
  const withBattery = quoteHasBattery(template, answers);
  if (template !== 'solar' && template !== 'battery') return;

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

  // Battery pre-job and handover tasks from the answers (template-job-tasks.js).
  if (withBattery) {
    tasksFor('battery', answers).forEach((t) => rows.push({ ...t, project_id: job.id }));
  }

  const { data: licences } = await supabaseAdmin
    .from('profile_licences')
    .select('licence_name, profiles!profile_licences_profile_id_fkey!inner(active)')
    .eq('profiles.active', true);
  const licenceNames = (licences || []).map((l) => l.licence_name || '');

  const solarCentres = (newStages || []).filter((c) => c.stc_system_kw != null || c.stc_total != null || c.stc_quantity != null);
  const ctx = {
    project: job,
    template,
    answers,
    withBattery,
    equipment,
    solarCentres,
    quotedTotal: (newStages || []).reduce((s, c) => s + (Number(c.quoted_amount) || 0), 0),
    hasAccreditedStaff:
      licenceNames.some((n) => /saa|accreditation/i.test(n)) &&
      licenceNames.some((n) => /electrical/i.test(n)),
    hasBatteryAccreditedStaff: licenceNames.some((n) => /saa|accreditation/i.test(n) && /batter/i.test(n)),
    hasBatteryAssetSerial: false, // a fresh job has nothing installed yet
    hasBatteryLocationPhoto: false,
    hasComplianceCertDoc: false, // legacy folder check; a fresh job has no CCEW yet, so the Upload the CCEW task is always created
    hasOwnerDeclarationDoc: false,
  };
  // One task each (bug review F5): the battery tasks from the answers (tasksFor('battery') above) already
  // ask for the battery serials and the location photo, whose rules can never be met on a fresh job (the
  // flags above are false), and on a battery-only job for the inverter serial and the Formbay job as well.
  const coveredByBatteryTasks = (id) =>
    (withBattery && (id === 'battery_serials_recorded' || id === 'battery_location_photo'))
    || (template === 'battery' && (id === 'inverter_serials_recorded' || id === 'formbay_lodged'));
  const handoverMissing = evaluate('handover', ctx).filter((r) => !r.met && !coveredByBatteryTasks(r.id));

  // Everything we install gets recorded against the customer so servicing and
  // warranty reminders can go out later (Installed equipment card on the job Summary tab).
  // A battery job's own "Record the battery and inverter serial numbers under Installed equipment" task says so already.
  if (!withBattery) {
    rows.push({
      project_id: job.id,
      description: 'Record the installed equipment under Installed equipment on the Summary tab',
      task_type: 'handover',
      required_before_scheduling: false,
    });
  }

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
