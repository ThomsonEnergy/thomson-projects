// Template-specific questions asked while building a quote (renovation and
// service work so far). Answers are saved on projects.template_answers
// (jsonb, keyed by question id) and copied onto the job when the quote is
// approved - netlify/functions/_shared/create-default-job-tasks.js turns
// them into that job's task list, so changing a question id here means
// changing it there too.

const TEMPLATE_QUESTIONS = {
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
  renovation: 'Renovation questions',
  service_work: 'Service work questions',
};

function renderTemplateQuestions(container, template, answers) {
  const questions = TEMPLATE_QUESTIONS[template] || [];
  answers = answers || {};
  container.innerHTML = questions.map(q => {
    const value = answers[q.id] ?? '';
    let input;
    if (q.type === 'yesno' || q.type === 'select') {
      const options = q.type === 'yesno' ? ['Yes', 'No'] : q.options;
      input = `<select class="tq-input" data-qid="${q.id}">
        <option value="">-- Select --</option>
        ${options.map(o => `<option value="${o}" ${value === o ? 'selected' : ''}>${o}</option>`).join('')}
      </select>`;
    } else {
      input = `<input class="tq-input" data-qid="${q.id}" placeholder="${q.placeholder || ''}" value="${String(value).replace(/"/g, '&quot;')}" />`;
    }
    return `<div><label>${q.label}</label>${input}</div>`;
  }).join('');
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
  const questions = TEMPLATE_QUESTIONS[template] || [];
  answers = answers || {};
  const rows = questions.filter(q => answers[q.id]).map(q =>
    `<tr><td>${q.label}</td><td>${String(answers[q.id]).replace(/</g, '&lt;')}</td></tr>`
  ).join('');
  return rows ? `<table><tbody>${rows}</tbody></table>` : `<p class="subtitle">No answers recorded yet.</p>`;
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
