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
