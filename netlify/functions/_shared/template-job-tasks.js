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

  // Battery proposal, or Solar with Batteries as well (create-default-job-tasks.js adds these
  // next to the solar ones). Rules: CER Cheaper Home Batteries Program, SAA, AS/NZS 5139.
  if (template === 'battery') {
    rows.push(pre('Check the battery and inverter are on the CEC approved product list on the day of ordering (the list changes)'));
    rows.push(pre('Confirm the installer on the job holds SAA grid connected battery systems (GCBS) accreditation'));
    rows.push(pre(`Lodge the DNSP connection application for the battery${a.dnsp ? ` (${a.dnsp})` : ''}${a.export_limit && a.export_limit !== 'Not known yet' ? `, export limit ${a.export_limit}` : ''}`));
    if (a.vpp_capable !== 'Yes') rows.push(pre('Battery not confirmed VPP capable: confirm with the supplier before ordering (required for the federal discount)'));
    if (a.cec_listed !== 'Yes') rows.push(pre('Battery not confirmed on the CEC approved list: confirm before ordering'));
    if (a.location_clear !== 'Yes') rows.push(pre('Agree a battery location that meets AS/NZS 5139 (not a habitable room, clear of exits, clearances, temperature) with the client'));
    if (a.first_battery !== 'Yes') rows.push(pre('Confirm no earlier battery discount claim at this address (one per premises)'));
    if (a.solar_commissioned_first !== 'Yes') rows.push(pre('Plan the solar commissioning before or with the battery (a battery with no solar is not eligible)'));
    if (a.state_rebate === 'Yes') rows.push(pre('Check the state rebate or loan paperwork can be stacked with the federal discount and lodge it'));
    if (a.backup_needs) rows.push(pre(`Design the backup circuits: ${a.backup_needs}`));
    if (a.internet === 'No') rows.push(pre('No internet at the site: arrange a 4G modem or SIM for battery monitoring and VPP'));

    rows.push(handover('Photograph the installed battery location showing the AS/NZS 5139 clearances and signage (caption the photo "battery")'));
    rows.push(handover('Record the battery and inverter serial numbers under Installed equipment'));
    rows.push(handover('Register the battery for VPP / monitoring and show the client the app'));
    rows.push(handover('Test the backup circuits with the grid off and show the client what stays on'));
    rows.push(handover('Create the Formbay battery job (BSTC) and upload the compliance documents'));
  }

  return rows;
}

module.exports = { tasksFor };
