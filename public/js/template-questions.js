// Pre-quote information asked while building a quote: where it came from
// (phone, site visit, email) plus the questions for the proposal type.
// Answers are saved on projects.template_answers (jsonb, keyed by question
// id) and copied onto the job when the quote is approved:
//  - netlify/functions/_shared/create-default-job-tasks.js turns them into
//    that job's task list (template-job-tasks.js), so changing a question id
//    here means changing it there too;
//  - netlify/functions/_shared/solar-compliance-rules.js reads the
//    `required` flags for the ready-to-send gate (this file is required from
//    there too, so it must stay plain script plus the module.exports guard
//    at the bottom: no DOM access at load time).
//
// `required: true` means the quote cannot be sent until it is answered.
// `requiredFor: ['battery']` narrows that to one template (battery
// questions also appear on a Solar quote with "Batteries as well").

// Asked on every quote, first. Create fills it when the quote comes from a lead or an email.
const GENERAL_QUESTIONS = [
  { id: 'info_source', type: 'select', label: 'Where this information came from', options: ['Phone call', 'Site visit', 'Client email', 'Lead form', 'In person'], required: true },
];

// One question for an existing system on both Solar and Battery quotes (it replaced the older
// existing_system and existing_system_detail answers, item 70; solar-roi.js still reads the old
// detail answer on older quotes). Required on a Battery quote: the battery couples to it.
const EXISTING_PV_QUESTION = { id: 'existing_pv', type: 'text', label: 'Existing solar or battery (size, inverter, year; blank if none)', placeholder: 'e.g. 6.6 kW, SMA Sunny Boy 5.0, 2018', requiredFor: ['battery'] };
// Whether that existing system stays once this job is done. The savings estimate counts a system
// that is coming off in the home as it is now and not after (solar-roi.js, roiExistingRemoved; the
// two answers are ROI_EXISTING_STAYS and ROI_EXISTING_GOES there). Saved under existing_system,
// the key the proposal is already given (older quotes hold "Existing solar" and the like under it,
// which read as not answered).
const EXISTING_AFTER_QUESTION = { id: 'existing_system', type: 'select', label: 'Existing system after this job (when there is one)', options: ['Stays on the roof', 'Coming off the roof'] };

// The export limit, typed in kW in total across the phases (or one tap for the usual ones). The
// savings estimate caps what goes to the grid at it (solar-roi.js, roiExportLimitKw); blank or
// "No limit" applies none. A bare number is saved as "7.5 kW". Asked once on a Solar quote with
// Batteries as well.
const EXPORT_LIMIT_QUESTION = { id: 'export_limit', type: 'kw', label: 'Export limit in kW, in total across the phases (blank if not known)', placeholder: 'e.g. 7.5', quick: ['No limit', 'Zero export', '5 kW', '10 kW'] };

// Only questions something reads: the ready-to-send gate (required), the job's tasks, the
// savings estimate, or the "What the customer gets" lines sent to the AI scope of works.
// Roof, switchboard, meter and NMI photos are on the site inspection checklist.
const SOLAR_QUESTIONS = [
  { id: 'with_battery', type: 'yesno', label: 'Batteries as well? (adds the battery questions and rules)', required: true },
  { id: 'life_support', type: 'yesno', label: 'Anyone on site on medical or life-support equipment? (Yes adds a job task to tell the network)', required: true },
  EXISTING_PV_QUESTION,
  EXISTING_AFTER_QUESTION,
  { id: 'grid_type', type: 'select', label: 'Grid connection', options: ['Grid connected', 'Grid connected, VPP interest', 'Off grid'] },
  { id: 'roof_type', type: 'select', label: 'Roof type', options: ['Tin (Colorbond)', 'Tile', 'Klip-lok', 'Flat or membrane', 'Ground mount', 'Other'] },
  { id: 'phases', type: 'select', label: 'Supply (filled from the bill when it shows)', options: ['Single phase', 'Three phase', 'Not sure'] },
  { id: 'nmi', type: 'text', label: 'NMI (filled from the bill; copied to the job)', placeholder: '10 or 11 characters' },
  { id: 'dnsp', type: 'select', label: 'Network (DNSP, filled from the bill)', options: ['Essential Energy', 'Ausgrid', 'Endeavour Energy', 'Energex', 'Other'] },
  EXPORT_LIMIT_QUESTION,
];

// Battery proposal, and a Solar proposal with "Batteries as well". The battery quoted is the
// one on the bill card (step 1) or the battery lines, never an answer here.
const BATTERY_QUESTIONS = [
  { id: 'backup_needs', type: 'text', label: 'What must stay on in a blackout', placeholder: 'e.g. fridge, lights, pump, nothing', required: true },
  EXISTING_PV_QUESTION,
  EXISTING_AFTER_QUESTION,
  { id: 'location_clear', type: 'yesno', label: 'Location clear of habitable rooms, exits and heat, with AS/NZS 5139 clearances?', required: true },
  { id: 'vpp_capable', type: 'yesno', label: 'Battery (or its inverter) VPP capable?', required: true },
  { id: 'cec_listed', type: 'yesno', label: 'Battery on the CEC approved product list?', required: true },
  { id: 'first_battery', type: 'yesno', label: 'First battery discount claim at this address?', required: true },
  { id: 'solar_commissioned_first', type: 'yesno', label: 'Solar commissioned before or with the battery?', required: true },
  { id: 'coupling', type: 'select', label: 'Coupling', options: ['Hybrid inverter (DC coupled)', 'AC coupled', 'Not sure'] },
  { id: 'battery_location', type: 'select', label: 'Where the battery goes', options: ['Garage', 'External wall', 'Under cover outside', 'Dedicated room', 'Other'] },
  { id: 'state_rebate', type: 'yesno', label: 'State rebate or loan as well?' },
  { id: 'internet', type: 'yesno', label: 'Internet at the site for monitoring?' },
  EXPORT_LIMIT_QUESTION,
];

const TEMPLATE_QUESTIONS = {
  solar: SOLAR_QUESTIONS,
  battery: BATTERY_QUESTIONS,
  renovation: [
    { id: 'built_pre_1990', type: 'yesno', label: 'Built before 1990? (possible asbestos in walls, ceilings or switchboard backing)' },
    { id: 'occupied', type: 'yesno', label: 'Will the property be occupied during the works?' },
    { id: 'switchboard_upgrade', type: 'yesno', label: 'Switchboard upgrade needed?' },
    { id: 'other_trades', type: 'yesno', label: 'Builder or other trades on site? (sequencing needs coordinating)' },
    { id: 'approval_needed', type: 'yesno', label: 'Strata, body corporate or heritage approval needed?' },
    { id: 'smoke_alarms', type: 'yesno', label: 'Smoke alarm upgrade required?' },
    { id: 'deadline', type: 'text', label: 'Hard deadline / must be finished by', placeholder: 'e.g. before settlement on 30 Nov' },
  ],
  service_work: [
    { id: 'urgency', type: 'select', label: 'Urgency', options: ['Emergency', 'Same day', 'This week', 'Routine'] },
    { id: 'fault', type: 'text', label: 'Fault or request', placeholder: 'e.g. Kitchen circuit keeps tripping' },
    { id: 'repeat_issue', type: 'yesno', label: 'Repeat issue, or previously attempted by us or another electrician?' },
    { id: 'power_off_ok', type: 'yesno', label: 'OK to switch the power off during the works?' },
    { id: 'parts_needed', type: 'yesno', label: 'Parts need to be sourced? (not on the van)' },
    { id: 'induction_needed', type: 'yesno', label: 'Site induction or work permit required?' },
    { id: 'site_contact', type: 'text', label: 'Site contact and access arrangements', placeholder: 'e.g. tenant Sam on 04xx xxx xxx, key in lockbox' },
  ],
};

// Questions taken off the form (item 70). Answers already given to them stay on the quote and the
// job and still show on the job, My Day and to the AI, under these labels.
const RETIRED_QUESTION_LABELS = {
  info_date: 'When', info_by: 'Who spoke to the client', info_notes: 'What the client asked for',
  existing_system: 'Existing solar or battery to tie into', existing_system_detail: 'Existing system details',
  roof_condition: 'Roof condition', storeys: 'Storeys', switchboard_type: 'Existing switchboard',
  daily_usage: 'Daily use (kWh)', shading: 'Shading', access: 'Access notes',
  battery_kwh_wanted: 'Usable kWh the customer asked for', distance_to_board: 'Distance to the switchboard (m)',
  walls_open: 'Wall and ceiling access',
};

// Answers to retired questions this quote still carries, as { label, value }.
function earlierAnswers(answers) {
  answers = answers || {};
  return Object.keys(RETIRED_QUESTION_LABELS).filter(id => String(answers[id] ?? '').trim()).map(id => ({ label: RETIRED_QUESTION_LABELS[id], value: answers[id] }));
}

const TEMPLATE_QUESTION_TITLES = {
  solar: 'Solar questions',
  battery: 'Battery questions',
  renovation: 'Renovation questions',
  service_work: 'Service work questions',
};

// True when the quote carries batteries: a Battery proposal, or a Solar one with Batteries as well.
function quoteHasBattery(template, answers) {
  return template === 'battery' || (template === 'solar' && (answers || {}).with_battery === 'Yes');
}

// Every question group this quote asks, in order: general, the template's own, then the
// battery set for a Solar quote with Batteries as well.
function questionGroupsForQuote(template, answers) {
  const groups = [{ title: 'Where this came from', questions: GENERAL_QUESTIONS }];
  if (TEMPLATE_QUESTIONS[template]) groups.push({ title: TEMPLATE_QUESTION_TITLES[template], questions: TEMPLATE_QUESTIONS[template] });
  if (template === 'solar' && quoteHasBattery(template, answers)) {
    // the existing system question is already in the solar set: asked once
    const asked = new Set(SOLAR_QUESTIONS.map(q => q.id));
    groups.push({ title: 'Battery questions', questions: BATTERY_QUESTIONS.filter(q => !asked.has(q.id)) });
  }
  return groups;
}

function questionIsRequired(q, template) {
  if (q.required) return true;
  return Array.isArray(q.requiredFor) && q.requiredFor.includes(template);
}

// Required questions still unanswered: what the ready-to-send gate reports.
function missingRequiredAnswers(template, answers) {
  answers = answers || {};
  const missing = [];
  questionGroupsForQuote(template, answers).forEach(g => {
    g.questions.forEach(q => {
      if (questionIsRequired(q, template) && !String(answers[q.id] ?? '').trim()) missing.push({ id: q.id, label: q.label });
    });
  });
  return missing;
}

function questionInputHtml(q, value, template) {
  const req = questionIsRequired(q, template) ? ' <span class="req" aria-hidden="true">*</span>' : '';
  const attr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  let input;
  if (q.type === 'yesno' || q.type === 'select') {
    const options = q.type === 'yesno' ? ['Yes', 'No'] : q.options;
    input = `<select class="tq-input" data-qid="${q.id}">
      <option value="">-- Select --</option>
      ${options.map(o => `<option value="${attr(o)}" ${value === o ? 'selected' : ''}>${attr(o)}</option>`).join('')}
    </select>`;
  } else if (q.type === 'textarea') {
    input = `<textarea class="tq-input" data-qid="${q.id}" placeholder="${attr(q.placeholder)}" style="min-height:70px;">${attr(value)}</textarea>`;
  } else if (q.type === 'kw') {
    // a typed number of kW, with the usual answers one tap away (the buttons fill the box)
    input = `<input class="tq-input" type="text" inputmode="decimal" data-qid="${q.id}" data-kw="1" placeholder="${attr(q.placeholder)}" value="${attr(value)}" />
      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;">${(q.quick || []).map(o => `<button type="button" class="secondary tq-quick" data-qid="${q.id}" data-value="${attr(o)}" style="font-size:12px; padding:4px 10px;">${attr(o)}</button>`).join('')}</div>`;
  } else {
    const type = q.type === 'date' ? 'date' : q.type === 'number' ? 'number' : 'text';
    const extra = q.type === 'number' ? ' step="0.1" inputmode="decimal"' : '';
    input = `<input class="tq-input" type="${type}"${extra} data-qid="${q.id}" placeholder="${attr(q.placeholder)}" value="${attr(value)}" />`;
  }
  return `<div${q.type === 'textarea' ? ' style="grid-column:1 / -1;"' : ''}><label>${attr(q.label)}${req}</label>${input}</div>`;
}

// Renders every group for the quote into `container`. Re-rendered when the template or the
// "Batteries as well" answer changes (the page listens for change on .tq-input[data-qid=with_battery]).
function renderTemplateQuestions(container, template, answers) {
  answers = answers || {};
  container.innerHTML = questionGroupsForQuote(template, answers).map(g => `
    <div class="tq-group" style="grid-column:1 / -1;">
      <h3 style="margin:14px 0 4px; font-size:14px;">${g.title}</h3>
    </div>
    ${g.questions.map(q => questionInputHtml(q, answers[q.id] ?? '', template)).join('')}
  `).join('');
  // a one-tap answer fills its box and counts as a change (the page listens for change on .tq-input)
  container.onclick = (e) => {
    const b = e.target.closest('.tq-quick');
    if (!b) return;
    const box = container.querySelector(`.tq-input[data-qid="${b.dataset.qid}"]`);
    if (!box) return;
    box.value = b.dataset.value;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };
}

function readTemplateAnswers(container) {
  const answers = {};
  container.querySelectorAll('.tq-input').forEach(el => {
    let v = el.value.trim();
    // a kW box: a bare number is saved with its unit ("7.5" becomes "7.5 kW")
    if (el.dataset.kw && /^\d+(\.\d+)?$/.test(v)) v = `${v} kW`;
    if (v) answers[el.dataset.qid] = v;
  });
  return answers;
}

function templateAnswersSummaryHtml(template, answers) {
  answers = answers || {};
  const rows = [];
  questionGroupsForQuote(template, answers).forEach(g => {
    g.questions.filter(q => answers[q.id]).forEach(q => {
      rows.push(`<tr><td>${q.label.replace(/</g, '&lt;')}</td><td>${String(answers[q.id]).replace(/</g, '&lt;')}</td></tr>`);
    });
  });
  earlierAnswers(answers).forEach(a => rows.push(`<tr><td>${a.label.replace(/</g, '&lt;')}</td><td>${String(a.value).replace(/</g, '&lt;')}</td></tr>`));
  return rows.length ? `<table><tbody>${rows.join('')}</tbody></table>` : `<p class="subtitle">No answers recorded yet.</p>`;
}

// Plain-text version of the answers for the AI scope of works prompt.
function templateAnswersText(template, answers) {
  answers = answers || {};
  const lines = [];
  questionGroupsForQuote(template, answers).forEach(g => {
    g.questions.filter(q => answers[q.id]).forEach(q => lines.push(`${q.label}: ${answers[q.id]}`));
  });
  earlierAnswers(answers).forEach(a => lines.push(`${a.label}: ${a.value}`));
  return lines.join('\n');
}

// What each proposal type is, shown on Create and used by both quote pages. photoCategory picks the
// Settings > Portfolio photos used on the proposal's inside pages; showPylon and showDeposit set
// which parts of step 3 (Pricing) show; singleStage types keep one stage.
const TEMPLATE_INFO = {
  new_build: { label: 'New Build', note: 'Multi-stage project with a deposit and a full scope of works.', photoCategory: 'electrical', showDeposit: true, showPylon: false },
  solar: { label: 'Solar Proposal', note: 'Solar questions and the electricity bill, with Batteries as well for the battery set. Pylon design and the STC credit on the quote.', photoCategory: 'solar', showDeposit: true, showPylon: true },
  battery: { label: 'Battery Proposal', note: 'Battery questions (backup, AS/NZS 5139 location, CEC list, VPP, federal discount), checked before sending, with the BSTC credit on the quote.', photoCategory: 'solar', showDeposit: true, showPylon: true },
  quick_estimate: { label: 'Quick Estimate', note: 'Single cost centre, no deposit, labelled "Estimate only" for the client and invoiced from actual hours and materials.', photoCategory: 'general', showDeposit: false, showPylon: false, singleStage: true },
  renovation: { label: 'Renovation', note: 'Multi-stage renovation with a deposit. Asks about asbestos, switchboard, approvals and occupancy, which set up the pre-work and handover tasks.', photoCategory: 'electrical', showDeposit: true, showPylon: false },
  service_work: { label: 'Service Work', note: 'Single-stage service call or repair with a deposit. Asks about urgency, access and parts.', photoCategory: 'electrical', showDeposit: true, showPylon: false, singleStage: true },
};

// Default deposit % and payment stages for each type, set at Create and again when the type is
// changed on step 1 (only where the quote still has the old type's defaults). The client's
// payment schedule is the deposit first, then these stages; together they make 100%. The deposit
// % is what is invoiced on approval.
const TEMPLATE_PAYMENT_DEFAULTS = {
  new_build: { deposit: 10, milestones: [] },
  renovation: { deposit: 10, milestones: [] },
  service_work: { deposit: 10, milestones: [] },
  solar: {
    deposit: 10,
    milestones: [
      { label: 'On ordering materials', percent: 40 },
      { label: 'On installation complete', percent: 30 },
      { label: 'On commissioning and handover', percent: 20 },
    ],
  },
  battery: {
    deposit: 10,
    milestones: [
      { label: 'On ordering the battery', percent: 50 },
      { label: 'On installation and commissioning', percent: 40 },
    ],
  },
  quick_estimate: { deposit: 0, milestones: [] },
};

// A milestone row that is the deposit itself (older quotes carried one in their milestones).
function isDepositMilestone(m) { return /^deposit\b/i.test(String((m && m.label) || '').trim()); }

// What a change of proposal type should set: the new type's deposit when the quote still has the
// old type's (or none), and its payment stages when the quote's are still the old type's untouched
// defaults (a leading deposit row on an older quote is ignored). Returns { deposit_percent?, milestones? }.
function paymentDefaultsOnTypeChange(prevTemplate, template, current) {
  const prev = TEMPLATE_PAYMENT_DEFAULTS[prevTemplate] || { deposit: null, milestones: [] };
  const next = TEMPLATE_PAYMENT_DEFAULTS[template];
  const out = {};
  if (!next) return out;
  const dep = current.deposit_percent;
  if (dep == null || Number(dep) === Number(prev.deposit) || Number(dep) === 0) out.deposit_percent = next.deposit;
  const stages = (current.milestones || []).filter(m => !isDepositMilestone(m));
  const untouched = stages.length === prev.milestones.length &&
    stages.every((m, i) => String(m.label).trim() === prev.milestones[i].label && Number(m.percent) === prev.milestones[i].percent);
  if (untouched) out.milestones = next.milestones.map(m => ({ ...m }));
  return out;
}

// The answers a new quote starts with: where it came from, when Create knows (a lead or an email).
function startingAnswers({ fromLead, fromEmail }) {
  if (fromLead) return { info_source: 'Lead form' };
  if (fromEmail) return { info_source: 'Client email' };
  return {};
}

// Server side (netlify/functions/_shared/solar-compliance-rules.js) requires this file for the
// ready-to-send gate. Browsers never see this branch.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GENERAL_QUESTIONS, SOLAR_QUESTIONS, BATTERY_QUESTIONS, TEMPLATE_QUESTIONS, TEMPLATE_INFO, TEMPLATE_PAYMENT_DEFAULTS, quoteHasBattery, questionGroupsForQuote, missingRequiredAnswers, templateAnswersText, paymentDefaultsOnTypeChange, isDepositMilestone, startingAnswers };
}
