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

// Asked on every quote, first.
const GENERAL_QUESTIONS = [
  { id: 'info_source', type: 'select', label: 'Where this information came from', options: ['Phone call', 'Site visit', 'Client email', 'Lead form', 'In person'], required: true },
  { id: 'info_date', type: 'date', label: 'When' },
  { id: 'info_by', type: 'text', label: 'Who spoke to the client', placeholder: 'e.g. Jasper' },
  { id: 'info_notes', type: 'textarea', label: 'What the client asked for, in their words', placeholder: 'Anything that should shape the scope or the price' },
];

const SOLAR_QUESTIONS = [
  { id: 'with_battery', type: 'yesno', label: 'Batteries as well? (adds the battery questions and rules)', required: true },
  { id: 'grid_type', type: 'select', label: 'Grid connection', options: ['Grid connected', 'Grid connected, VPP interest', 'Off grid'], required: true },
  { id: 'existing_system', type: 'select', label: 'Existing solar or battery to tie into', options: ['None', 'Existing solar', 'Existing battery', 'Existing solar and battery'], required: true },
  { id: 'existing_system_detail', type: 'text', label: 'Existing system details', placeholder: 'e.g. 6.6 kW, Fronius Primo 5, 2019' },
  { id: 'life_support', type: 'yesno', label: 'Anyone on site on medical or life-support equipment?', required: true },
  { id: 'roof_type', type: 'select', label: 'Roof type', options: ['Tin (Colorbond)', 'Tile', 'Klip-lok', 'Flat or membrane', 'Ground mount', 'Other'], required: true },
  { id: 'roof_condition', type: 'select', label: 'Roof condition', options: ['Good', 'Worn, needs a look', 'Needs repair first'] },
  { id: 'storeys', type: 'select', label: 'Storeys', options: ['Single', 'Double', 'Three or more'] },
  { id: 'switchboard_type', type: 'select', label: 'Existing switchboard', options: ['Modern, with RCDs', 'Older, circuit breakers only', 'Ceramic fuses', 'Not sure'], required: true },
  { id: 'phases', type: 'select', label: 'Supply', options: ['Single phase', 'Three phase', 'Not sure'], required: true },
  { id: 'nmi', type: 'text', label: 'NMI (from the electricity bill)', placeholder: '10 or 11 characters' },
  { id: 'dnsp', type: 'select', label: 'Network (DNSP)', options: ['Essential Energy', 'Ausgrid', 'Endeavour Energy', 'Energex', 'Other'] },
  { id: 'export_limit', type: 'select', label: 'Export limit', options: ['Not known yet', 'No limit', '5 kW', '10 kW', 'Zero export'] },
  { id: 'daily_usage', type: 'text', label: 'Daily use (kWh) or bill attached', placeholder: 'e.g. 22 kWh/day, bill in Documents' },
  { id: 'shading', type: 'select', label: 'Shading', options: ['None', 'Some', 'Heavy'] },
  { id: 'access', type: 'text', label: 'Access notes', placeholder: 'Roof access, parking, dogs, gate code' },
];

// Battery proposal, and a Solar proposal with "Batteries as well".
const BATTERY_QUESTIONS = [
  { id: 'battery_kwh_wanted', type: 'number', label: 'Usable kWh wanted', placeholder: '5 to 100 for the federal discount (first 50 kWh discounted)', required: true },
  { id: 'backup_needs', type: 'text', label: 'What must stay on in a blackout', placeholder: 'e.g. fridge, lights, pump, nothing', required: true },
  { id: 'existing_pv', type: 'text', label: 'Existing PV size and inverter', placeholder: 'e.g. 6.6 kW, SMA Sunny Boy 5.0, 2018', requiredFor: ['battery'] },
  { id: 'coupling', type: 'select', label: 'Coupling', options: ['Hybrid inverter (DC coupled)', 'AC coupled', 'Not sure'], required: true },
  { id: 'battery_location', type: 'select', label: 'Where the battery goes', options: ['Garage', 'External wall', 'Under cover outside', 'Dedicated room', 'Other'], required: true },
  { id: 'location_clear', type: 'yesno', label: 'Location clear of habitable rooms, exits and heat, with AS/NZS 5139 clearances?', required: true },
  { id: 'distance_to_board', type: 'text', label: 'Distance to the switchboard (m)', placeholder: 'e.g. 4' },
  { id: 'vpp_capable', type: 'yesno', label: 'Battery (or its inverter) VPP capable?', required: true },
  { id: 'cec_listed', type: 'yesno', label: 'Battery on the CEC approved product list?', required: true },
  { id: 'first_battery', type: 'yesno', label: 'First battery discount claim at this address?', required: true },
  { id: 'solar_commissioned_first', type: 'yesno', label: 'Solar commissioned before or with the battery?', required: true },
  { id: 'state_rebate', type: 'yesno', label: 'State rebate or loan as well?' },
  { id: 'internet', type: 'yesno', label: 'Internet at the site for monitoring?' },
];

const TEMPLATE_QUESTIONS = {
  solar: SOLAR_QUESTIONS,
  battery: BATTERY_QUESTIONS,
  renovation: [
    { id: 'built_pre_1990', type: 'yesno', label: 'Built before 1990? (possible asbestos in walls, ceilings or switchboard backing)' },
    { id: 'occupied', type: 'yesno', label: 'Will the property be occupied during the works?' },
    { id: 'switchboard_upgrade', type: 'yesno', label: 'Switchboard upgrade needed?' },
    { id: 'switchboard_type', type: 'select', label: 'Existing switchboard', options: ['Modern, with RCDs', 'Older, circuit breakers only', 'Ceramic fuses', 'Not sure'] },
    { id: 'walls_open', type: 'select', label: 'Wall and ceiling access', options: ['Already stripped back', 'Closed - cut-ins needed', 'Mixed'] },
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
  if (template === 'solar' && quoteHasBattery(template, answers)) groups.push({ title: 'Battery questions', questions: BATTERY_QUESTIONS });
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
}

function readTemplateAnswers(container) {
  const answers = {};
  container.querySelectorAll('.tq-input').forEach(el => {
    const v = el.value.trim();
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
  return rows.length ? `<table><tbody>${rows.join('')}</tbody></table>` : `<p class="subtitle">No answers recorded yet.</p>`;
}

// Plain-text version of the answers for the AI scope of works prompt.
function templateAnswersText(template, answers) {
  answers = answers || {};
  const lines = [];
  questionGroupsForQuote(template, answers).forEach(g => {
    g.questions.filter(q => answers[q.id]).forEach(q => lines.push(`${q.label}: ${answers[q.id]}`));
  });
  return lines.join('\n');
}

// Default deposit % and payment milestones for each template, pre-filled in
// the quote editor (new-project.html / project.html) and editable per quote
// from there. Milestones are what the client sees on the quote's payment
// schedule - everything is invoiced after completion of each milestone, or
// as a progress claim at the end of the month (see the schedule's footnote
// in quote.html). The deposit % is what's actually auto-invoiced on approval.
const TEMPLATE_PAYMENT_DEFAULTS = {
  new_build: { deposit: 10, milestones: [] },
  renovation: { deposit: 10, milestones: [] },
  service_work: { deposit: 10, milestones: [] },
  solar: {
    deposit: 10,
    milestones: [
      { label: 'Deposit, due on acceptance', percent: 10 },
      { label: 'On ordering materials', percent: 40 },
      { label: 'On installation complete', percent: 30 },
      { label: 'On commissioning and handover', percent: 20 },
    ],
  },
  battery: {
    deposit: 10,
    milestones: [
      { label: 'Deposit, due on acceptance', percent: 10 },
      { label: 'On ordering the battery', percent: 50 },
      { label: 'On installation and commissioning', percent: 40 },
    ],
  },
  quick_estimate: { deposit: 0, milestones: [] },
};

// Fills the deposit field and milestone rows with the new template's
// defaults - but only where the person hasn't changed them: the deposit is
// replaced only if it's blank or still the previous template's default, and
// the milestones only if there are none or they're still the previous
// template's untouched defaults. Relies on the page's own milestoneRowHtml /
// wireMilestoneRows / refreshMilestoneTotal.
function applyTemplatePaymentDefaults(prevTemplate, template) {
  const prev = TEMPLATE_PAYMENT_DEFAULTS[prevTemplate] || { deposit: null, milestones: [] };
  const next = TEMPLATE_PAYMENT_DEFAULTS[template];
  if (!next) return;

  const depositEl = document.getElementById('p-deposit');
  if (depositEl && next.deposit > 0 && (depositEl.value === '' || Number(depositEl.value) === Number(prev.deposit) || Number(depositEl.value) === 0)) {
    depositEl.value = next.deposit;
  }

  const rowsEl = document.getElementById('milestone-rows');
  if (!rowsEl) return;
  const current = [...rowsEl.querySelectorAll('.milestone-row')].map(r => ({
    label: r.querySelector('.milestone-label').value.trim(),
    percent: parseFloat(r.querySelector('.milestone-percent').value) || 0,
  }));
  const untouched = current.length === prev.milestones.length &&
    current.every((m, i) => m.label === prev.milestones[i].label && m.percent === prev.milestones[i].percent);
  if (!untouched) return;
  rowsEl.innerHTML = next.milestones.map(m => milestoneRowHtml(m)).join('');
  wireMilestoneRows();
  refreshMilestoneTotal();
}

// Server side (netlify/functions/_shared/solar-compliance-rules.js) requires this file for the
// ready-to-send gate. Browsers never see this branch.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GENERAL_QUESTIONS, SOLAR_QUESTIONS, BATTERY_QUESTIONS, TEMPLATE_QUESTIONS, quoteHasBattery, questionGroupsForQuote, missingRequiredAnswers, templateAnswersText };
}
