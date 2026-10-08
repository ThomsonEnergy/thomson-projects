// Default job tasks for the renovation and service work quote templates,
// built from the answers saved on the quote (projects.template_answers -
// question ids are defined in public/js/template-questions.js). Same shape
// as the solar tasks in create-default-job-tasks.js: 'prejob' tasks are
// what must be done before the job can be booked (required_before_scheduling
// holds it at Awaiting Action until they're ticked), 'handover' tasks are
// the sign-off checklist after the work.

function tasksFor(template, a) {
  const pre = (description) => ({ description, task_type: 'prejob', required_before_scheduling: true });
  const handover = (description) => ({ description, task_type: 'handover', required_before_scheduling: false });
  const yes = (id) => a[id] === 'Yes';
  const rows = [];

  if (template === 'renovation') {
    rows.push(pre('Site walk-through: photograph the existing switchboard, wiring and any problem areas before starting'));
    if (yes('built_pre_1990')) rows.push(pre('Confirm the asbestos register or clearance with the client before disturbing walls, ceilings or switchboard backing'));
    if (yes('approval_needed')) rows.push(pre('Get strata, body corporate or heritage approval in writing'));
    if (yes('switchboard_upgrade')) {
      rows.push(pre('Order the new switchboard and protection devices'));
      rows.push(pre('Book the network power disconnection and reconnection for the switchboard upgrade'));
    }
    if (yes('other_trades')) rows.push(pre('Confirm trade sequencing and access dates with the builder / other trades'));
    if (yes('occupied')) rows.push(pre('Agree power-off windows with the occupants'));
    if (a.deadline) rows.push(pre(`Confirm the schedule can meet the client's deadline: ${a.deadline}`));

    rows.push(handover('Test and record results (insulation resistance, earth continuity, RCD trip times)'));
    if (yes('switchboard_upgrade')) rows.push(handover('Label the new switchboard circuits and leave an updated circuit directory'));
    if (yes('smoke_alarms')) rows.push(handover('Install and test interconnected smoke alarms and record compliance'));
    rows.push(handover('Issue the Certificate of Electrical Safety to the client'));
    rows.push(handover('Final clean-up and walk-through with the client'));
  }

  if (template === 'service_work') {
    rows.push(pre(`Confirm access and a site contact with the client${a.site_contact ? ` (${a.site_contact})` : ''}`));
    if (yes('parts_needed')) rows.push(pre('Source and collect the parts needed for the job'));
    if (yes('induction_needed')) rows.push(pre('Complete the site induction or get the work permit'));
    if (a.power_off_ok === 'No') rows.push(pre('Plan how to isolate safely - the client cannot have the power switched off'));

    rows.push(handover('Photograph the fault and the repair (before and after)'));
    rows.push(handover('Test and record results; issue a Certificate of Electrical Safety if required'));
    if (yes('repeat_issue')) rows.push(handover('Note the root cause and recommend any follow-up work to the client'));
  }

  return rows;
}

module.exports = { tasksFor };
