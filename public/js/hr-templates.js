// Printable HR templates: the written warning letter and the incident and
// injury report (SafeWork NSW WHS Form 10). Each builds a complete,
// self-contained HTML document from a saved record, or from an empty
// object for a blank paper copy, and printHrDocument() opens it in a new
// window ready to print or "Save as PDF". Used by staff.html.

const HR_COMPANY_FALLBACK = { company_name: 'Thomson Energy Australia Pty Ltd', abn: '', address: '', phone: '' };

const WARNING_LEVEL_LABELS = { first: 'First written warning', second: 'Second written warning', final: 'Final written warning' };
const WARNING_CATEGORY_LABELS = {
  conduct: 'Conduct', performance: 'Performance', safety: 'Workplace health and safety',
  attendance: 'Attendance and punctuality', policy: 'Breach of company policy', other: 'Other',
};
const INCIDENT_NATURE_LABELS = {
  near_miss: 'Near miss', first_aid: 'First aid', medical_treatment: 'Medical treatment/doctor', property_damage: 'Property, plant or environmental damage',
};
const BODY_LOCATIONS = [
  'Head', 'Face', 'Eyes', 'Neck', 'Left shoulder', 'Right shoulder', 'Left arm', 'Right arm',
  'Left hand/fingers', 'Right hand/fingers', 'Chest', 'Abdomen', 'Upper back', 'Lower back',
  'Hips/groin', 'Left leg', 'Right leg', 'Left knee', 'Right knee', 'Left ankle/foot', 'Right ankle/foot', 'Internal/multiple',
];

// What happens if it isn't fixed - the default wording per level, used
// whenever the warning's own consequences field is left blank.
function defaultWarningConsequences(level) {
  if (level === 'final') {
    return 'This is a final written warning. If there is any further instance of this or any other conduct or performance concern, the company is likely to terminate your employment.';
  }
  if (level === 'second') {
    return 'If the required improvement is not made and maintained, or there is any further concern, the company may take further disciplinary action, which may include a final written warning or the termination of your employment.';
  }
  return 'If the required improvement is not made and maintained, or there is any further concern, the company may take further disciplinary action, which may include further warnings or the termination of your employment.';
}

function hrEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hrDate(d) {
  if (!d) return '';
  const dt = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T00:00:00') : new Date(d);
  return isNaN(dt) ? '' : dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}
// Multi-line text, or a run of blank writing lines on a blank template.
function hrText(value, blankLines = 3) {
  if (value && String(value).trim()) return `<div class="filled">${hrEsc(value).replace(/\n/g, '<br>')}</div>`;
  return `<div class="lines">${'<div class="line"></div>'.repeat(blankLines)}</div>`;
}
function hrBox(checked) { return `<span class="box">${checked ? '&#10003;' : ''}</span>`; }
function hrYesNo(v) { return `Yes ${hrBox(v === true)} &nbsp; No ${hrBox(v === false)}`; }

const HR_BASE_CSS = `
  @page { size: A4; margin: 16mm 15mm; }
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; font-size: 10.5pt; color: #111; line-height: 1.45; margin: 0; }
  .letterhead { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1d3a5f; padding-bottom: 10px; margin-bottom: 18px; }
  .letterhead img { max-height: 54px; max-width: 220px; }
  .letterhead .co { text-align: right; font-size: 9pt; color: #444; }
  .letterhead .co strong { font-size: 10.5pt; color: #111; }
  h1 { font-size: 15pt; color: #1d3a5f; margin: 0 0 4px; letter-spacing: 0.02em; }
  h2 { font-size: 11pt; margin: 18px 0 6px; color: #1d3a5f; }
  p { margin: 0 0 8px; }
  .muted { color: #555; font-size: 9pt; }
  .filled { white-space: normal; }
  .lines .line { border-bottom: 1px solid #999; height: 22px; }
  .box { display: inline-block; width: 12px; height: 12px; border: 1px solid #333; vertical-align: -1px; text-align: center; font-size: 10px; line-height: 11px; }
  table.form { width: 100%; border-collapse: collapse; margin-bottom: 10px; page-break-inside: avoid; }
  table.form th { background: #a9c3cc; text-align: left; padding: 5px 7px; font-size: 10pt; border: 1px solid #555; }
  table.form td { border: 1px solid #555; padding: 5px 7px; vertical-align: top; font-size: 9.5pt; }
  table.form td.lbl { width: 28%; color: #333; }
  .sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; margin-top: 22px; page-break-inside: avoid; }
  .sig-block .sig-line { border-bottom: 1px solid #333; height: 44px; margin-bottom: 4px; display: flex; align-items: flex-end; }
  .sig-block .sig-line img { max-height: 42px; }
  .sig-block .row { font-size: 9pt; margin-top: 10px; border-bottom: 1px solid #999; padding-bottom: 2px; min-height: 18px; }
  .confidential { font-weight: bold; letter-spacing: 0.08em; font-size: 9pt; margin-bottom: 12px; }
  .toolbar { position: fixed; top: 10px; right: 10px; }
  .toolbar button { font-size: 13px; padding: 8px 14px; cursor: pointer; }
  @media print { .toolbar { display: none; } }
  @media screen { body { max-width: 820px; margin: 0 auto; padding: 56px 20px 30px; } }
`;

function hrLetterhead(company) {
  const c = company || HR_COMPANY_FALLBACK;
  return `<div class="letterhead">
    <div>${c.logo_url ? `<img src="${hrEsc(c.logo_url)}" alt="" />` : `<strong>${hrEsc(c.company_name || HR_COMPANY_FALLBACK.company_name)}</strong>`}</div>
    <div class="co"><strong>${hrEsc(c.company_name || HR_COMPANY_FALLBACK.company_name)}</strong><br>
      ${c.abn ? 'ABN ' + hrEsc(c.abn) + '<br>' : ''}${c.address ? hrEsc(c.address) + '<br>' : ''}${c.phone ? hrEsc(c.phone) : ''}</div>
  </div>`;
}

function hrDocument(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${hrEsc(title)}</title><style>${HR_BASE_CSS}</style></head>
    <body><div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>${bodyHtml}</body></html>`;
}

// w: a staff_warnings row (or {} for blank). person: { full_name, job_title }.
function writtenWarningHtml(w = {}, person = {}, company = null) {
  const blank = !w.id;
  const level = w.warning_level || 'first';
  const levelLabel = blank ? 'First / Second / Final written warning' : WARNING_LEVEL_LABELS[level];
  const name = person.full_name || '';
  const firstName = name.split(' ')[0];
  const category = blank ? '' : (WARNING_CATEGORY_LABELS[w.category] || '');
  const meeting = w.meeting_date ? hrDate(w.meeting_date) : '____________________';
  const consequences = (w.consequences && w.consequences.trim()) || (blank ? '' : defaultWarningConsequences(level));

  const body = `
    ${hrLetterhead(company)}
    <p class="confidential">PRIVATE AND CONFIDENTIAL</p>
    <p>${w.issued_date ? hrDate(w.issued_date) : 'Date: ____________________'}</p>
    <p>${name ? `<strong>${hrEsc(name)}</strong>` : 'Employee name: ________________________________'}<br>
      ${person.job_title ? hrEsc(person.job_title) : (blank ? 'Position: ________________________________' : '')}</p>

    <h1>${hrEsc(levelLabel.toUpperCase())}</h1>
    <p class="muted">${category ? 'Concern: ' + hrEsc(category) : 'Concern: Conduct / Performance / Safety / Attendance / Policy / Other'}${w.subject ? ' - ' + hrEsc(w.subject) : ''}</p>

    <p>Dear ${firstName ? hrEsc(firstName) : '____________'},</p>
    <p>This letter confirms our meeting on ${meeting}${w.issued_by_name ? ` with ${hrEsc(w.issued_by_name)}` : ''}${w.support_person ? `, at which ${hrEsc(w.support_person)} attended as your support person` : ''}. At that meeting we raised the concerns set out below and gave you the opportunity to respond before any decision was made.</p>

    <h2>1. The concern</h2>
    ${w.incident_date ? `<p class="muted">Date of incident: ${hrDate(w.incident_date)}</p>` : (blank ? '<p class="muted">Date of incident: ____________________</p>' : '')}
    ${hrText(w.details, 5)}

    <h2>2. Policy, procedure or expectation not met</h2>
    ${hrText(w.policy_breached, 2)}

    <h2>3. Previous discussions</h2>
    ${hrText(w.previous_discussions || (blank ? '' : 'None recorded.'), 2)}

    <h2>4. Your response</h2>
    ${hrText(w.employee_response, 3)}

    <h2>5. Outcome</h2>
    <p>Having considered your response, the company has decided to issue you with this <strong>${hrEsc(blank ? 'first / second / final written warning' : levelLabel.toLowerCase())}</strong>.</p>

    <h2>6. What is expected of you</h2>
    ${hrText(w.expected_improvement, 3)}

    <h2>7. Support the company will provide</h2>
    ${hrText(w.support_offered, 2)}

    <h2>8. Review</h2>
    <p>${w.review_date ? `We will review your progress on or around <strong>${hrDate(w.review_date)}</strong>.` : 'Review date: ____________________'}</p>

    <h2>9. Consequences</h2>
    ${hrText(consequences, 2)}

    <p style="margin-top:14px;">A copy of this letter will be kept on your personnel file. You may provide a written response to this letter, which will also be kept on your file. If you have any questions, or believe anything in this letter is inaccurate, please raise it with ${w.issued_by_name ? hrEsc(w.issued_by_name) : 'your manager'}.</p>
    <p>Yours sincerely,</p>

    <div class="sig-grid">
      <div class="sig-block">
        <div class="sig-line"></div>
        <div class="row">Name: ${hrEsc(w.issued_by_name || '')}</div>
        <div class="row">Position: ${hrEsc(w.issued_by_position || '')}</div>
        <div class="row">Date:</div>
        <p class="muted">For and on behalf of ${hrEsc((company && company.company_name) || HR_COMPANY_FALLBACK.company_name)}</p>
      </div>
      <div class="sig-block">
        <div class="sig-line"></div>
        <div class="row">Employee: ${hrEsc(name)}</div>
        <div class="row">Date:</div>
        <p class="muted">I acknowledge I have received and read this letter. Signing it does not mean I agree with its contents.</p>
      </div>
    </div>
    <div class="sig-grid">
      <div class="sig-block">
        <div class="sig-line"></div>
        <div class="row">Witness / support person: ${hrEsc(w.support_person || '')}</div>
        <div class="row">Date:</div>
      </div>
      <div class="sig-block">
        <p style="margin-top:20px;">${hrBox(w.refused_to_sign)} Employee declined to sign (witness to sign and date)</p>
      </div>
    </div>

    <h2>Employee comments (optional)</h2>
    ${hrText('', 5)}
  `;
  return hrDocument(`${levelLabel}${name ? ' - ' + name : ''}`, body);
}

// r: an incident_reports row (or {} for blank).
function incidentReportHtml(r = {}, company = null) {
  const t = r.incident_time ? String(r.incident_time).slice(0, 5) : '';
  const [hh, mm] = t ? t.split(':').map(Number) : [null, null];
  const time12 = t ? `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')}` : '';
  const amPm = t ? `am ${hrBox(hh < 12)} &nbsp; pm ${hrBox(hh >= 12)}` : `am ${hrBox()} &nbsp; pm ${hrBox()}`;
  const cell = (v) => hrEsc(v || '');
  const witnesses = (r.witnesses && r.witnesses.length ? r.witnesses : []).concat([{}, {}]).slice(0, Math.max(2, (r.witnesses || []).length));
  const locs = r.body_locations || [];
  const isDamage = r.nature === 'property_damage';

  const body = `
    ${hrLetterhead(company)}
    <h1>WHS FORM 10: INCIDENT AND INJURY REPORT</h1>
    <p class="muted">Based on the SafeWork NSW Housing Industry Site Safety Pack, Form 10.${r.id ? ' Record ' + hrEsc(String(r.id).slice(0, 8).toUpperCase()) : ''}</p>

    <table class="form">
      <tr><th colspan="4">Details of injury (eg to a worker or visitor) and treatment</th></tr>
      <tr><td class="lbl">Date of incident</td><td>${hrDate(r.incident_date)}</td><td class="lbl">Time of incident</td><td>${time12} &nbsp; ${amPm}</td></tr>
      <tr><td class="lbl">Nature of incident</td><td colspan="3">${hrBox(r.nature === 'near_miss')} Near miss &nbsp;&nbsp; ${hrBox(r.nature === 'first_aid')} First aid &nbsp;&nbsp; ${hrBox(r.nature === 'medical_treatment')} Medical treatment/doctor &nbsp;&nbsp; ${hrBox(isDamage)} Property damage only</td></tr>
      <tr><td class="lbl">Name of injured person</td><td colspan="3">${cell(r.injured_name)}</td></tr>
      <tr><td class="lbl">Address</td><td colspan="3">${cell(r.injured_address)}</td></tr>
      <tr><td class="lbl">Occupation</td><td colspan="3">${cell(r.injured_occupation)}</td></tr>
      <tr><td class="lbl">Date of birth</td><td colspan="3">${hrDate(r.injured_dob)}</td></tr>
      <tr><td class="lbl">Telephone</td><td colspan="3">${cell(r.injured_phone)}</td></tr>
      <tr><td class="lbl">Employer</td><td colspan="3">${cell(r.injured_employer)}</td></tr>
      <tr><td class="lbl">Activity in which the person was engaged at the time of injury</td><td colspan="3">${cell(r.activity)}</td></tr>
      <tr><td class="lbl">Exact site location where injury occurred</td><td colspan="3">${cell(r.site_location)}</td></tr>
      <tr><td class="lbl">Nature of injury (eg fracture, burn, sprain, foreign body in eye)</td><td colspan="3">${cell(r.injury_nature)}</td></tr>
      <tr><td class="lbl">Body location of injury</td><td colspan="3">
        <div style="columns:3; font-size:9pt;">${BODY_LOCATIONS.map(b => `<div>${hrBox(locs.includes(b))} ${b}</div>`).join('')}</div>
        ${r.body_location_notes ? `<div style="margin-top:6px;">${cell(r.body_location_notes)}</div>` : ''}</td></tr>
      <tr><td class="lbl">Treatment given on site</td><td>${cell(r.treatment_on_site)}</td><td class="lbl">Name of treating person</td><td>${cell(r.treating_person)}</td></tr>
      <tr><td class="lbl">Referral for further treatment?<br>${hrYesNo(r.referral)}</td><td>Name of doctor or hospital:<br>${cell(r.doctor_or_hospital)}</td><td class="lbl">SafeWork NSW medical certificate received?<br>${hrYesNo(r.medical_cert_received)}</td><td>Attach copies</td></tr>
      <tr><td class="lbl">Injury management requirement?<br>${hrYesNo(r.injury_management)}</td><td>Notify return to work coordinator<br>${hrYesNo(r.rtw_coordinator_notified)}</td><td class="lbl">Name of return to work coordinator</td><td>${cell(r.rtw_coordinator_name)}</td></tr>
    </table>

    <table class="form">
      <tr><th colspan="4">Witness to incident (each witness may need to provide an account of what happened)</th></tr>
      ${witnesses.map(w => `<tr><td class="lbl">Witness name</td><td>${cell(w.name)}</td><td class="lbl">Witness contact</td><td>${cell(w.contact)}</td></tr>`).join('')}
    </table>

    <table class="form">
      <tr><th colspan="4">Details of incident (eg property, plant or environmental damage)</th></tr>
      <tr><td class="lbl">Date of incident</td><td>${hrDate(r.incident_date)}</td><td class="lbl">Time of incident</td><td>${time12} &nbsp; ${amPm}</td></tr>
      <tr><td class="lbl">Location of incident</td><td colspan="3">${cell(r.site_location)}</td></tr>
      <tr><td class="lbl">Details of damage to equipment or property</td><td colspan="3">${r.property_damage ? cell(r.property_damage) : '<div style="height:30px;"></div>'}</td></tr>
      <tr><td class="lbl">Name of person who received the report</td><td>${cell(r.report_received_by)}</td><td class="lbl">Telephone</td><td>${cell(r.report_received_phone)}</td></tr>
    </table>

    <table class="form">
      <tr><th>Description of incident</th></tr>
      <tr><td>${hrText(r.description, 8)}</td></tr>
    </table>

    <table class="form">
      <tr><th>Immediate response actions (eg barricades, isolation of power) to stabilise the situation</th></tr>
      <tr><td>${hrText(r.immediate_actions, 3)}</td></tr>
    </table>

    <table class="form">
      <tr><th colspan="2">Reported to</th></tr>
      <tr><td class="lbl">Reported to principal contractor?<br>${hrYesNo(r.reported_principal_contractor)}</td><td>Provide details (when, reported to and reported by):<br>${cell(r.reported_principal_contractor_details)}</td></tr>
      <tr><td class="lbl">Reported to authorities (SafeWork NSW phone: <strong>13 10 50</strong>)?<br>${hrYesNo(r.reported_safework)}</td><td>Provide details (when, reported to and reported by):<br>${cell(r.reported_safework_details)}</td></tr>
      <tr><td class="lbl">Reported to workers compensation insurer?<br>${hrYesNo(r.reported_insurer)}</td><td>Provide details (name of insurer and claim number):<br>${cell(r.reported_insurer_details)}</td></tr>
    </table>

    <table class="form">
      <tr><th>Corrective actions (what will be done to stop it happening again)</th></tr>
      <tr><td>${hrText(r.corrective_actions, 3)}</td></tr>
    </table>

    <table class="form">
      <tr><th colspan="4">Completed by</th></tr>
      <tr><td class="lbl">Name</td><td>${cell(r.completed_by_name)}</td><td class="lbl">Position</td><td>${cell(r.completed_by_position)}</td></tr>
      <tr><td class="lbl">Signature</td><td style="height:48px;">${r.completed_signature_data_url ? `<img src="${hrEsc(r.completed_signature_data_url)}" style="max-height:44px;" />` : ''}</td><td class="lbl">Date</td><td>${hrDate(r.completed_date)}</td></tr>
    </table>
    <p class="muted">Serious injuries, illnesses and dangerous incidents are notifiable to SafeWork NSW immediately on 13 10 50. Keep the site undisturbed until an inspector says otherwise. Keep this record for at least 5 years.</p>
  `;
  return hrDocument(`Incident report${r.injured_name ? ' - ' + r.injured_name : ''}${r.incident_date ? ' - ' + r.incident_date : ''}`, body);
}

function printHrDocument(html) {
  const win = window.open('', '_blank');
  if (!win) { alert('Your browser blocked the new window - allow pop-ups for this site and try again.'); return; }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.onload = () => setTimeout(() => win.print(), 300);
}
