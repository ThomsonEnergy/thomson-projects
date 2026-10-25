// HR documents: written warnings, letters of counselling, resolution letters,
// the incident and injury report (SafeWork NSW WHS Form 10), and the full
// incident pack for a workers comp claim or SafeWork. Each builds a
// complete, self-contained HTML document from saved records (or from empty
// objects for a blank paper copy). showHrDocument() shows one inside the
// app; printHrDocument() opens it in a new window to print or save as PDF.
// Used by staff.html, incident.html, incidents.html and letter.html.

const HR_COMPANY_FALLBACK = { company_name: 'Thomson Energy Australia Pty Ltd', abn: '', address: '', phone: '' };

const WARNING_LEVEL_LABELS = { first: 'First written warning', second: 'Second written warning', final: 'Final written warning' };
const WARNING_CATEGORY_LABELS = {
  conduct: 'Conduct', performance: 'Performance', safety: 'Workplace health and safety',
  attendance: 'Attendance and punctuality', policy: 'Breach of company policy', other: 'Other',
};
const WARNING_STATUS_LABELS = { draft: 'Draft', issued: 'Issued', acknowledged: 'Signed by employee', resolved: 'Resolved', withdrawn: 'Withdrawn' };
const INCIDENT_NATURE_LABELS = {
  near_miss: 'Near miss', first_aid: 'First aid', medical_treatment: 'Medical treatment/doctor', lost_time: 'Lost time injury',
  dangerous_incident: 'Dangerous incident', property_damage: 'Property, plant or environmental damage',
};
const INCIDENT_ROLE_LABELS = {
  injured: 'Injured', involved: 'Directly involved', contributed: 'Contributed', witness: 'Witness',
  reported: 'Reported it', supervisor: 'Supervisor', other: 'Other',
};
const BODY_LOCATIONS = [
  'Head', 'Face', 'Eyes', 'Neck', 'Left shoulder', 'Right shoulder', 'Left arm', 'Right arm',
  'Left hand/fingers', 'Right hand/fingers', 'Chest', 'Abdomen', 'Upper back', 'Lower back',
  'Hips/groin', 'Left leg', 'Right leg', 'Left knee', 'Right knee', 'Left ankle/foot', 'Right ankle/foot', 'Internal/multiple',
];
// WHS Act 2011 (NSW) ss 35-37: if any of these happened, SafeWork NSW must
// be told immediately (13 10 50) and the site left undisturbed.
const NOTIFIABLE_CATEGORIES = [
  'Death of a person',
  'Serious injury or illness: treatment as an in-patient in hospital',
  'Serious injury or illness: amputation, serious head, eye or spinal injury, serious burn, degloving or scalping, serious laceration',
  'Serious injury or illness: loss of a bodily function',
  'Serious injury or illness: medical treatment within 48 hours of exposure to a substance',
  'Dangerous incident: electric shock',
  'Dangerous incident: uncontrolled implosion, explosion or fire',
  'Dangerous incident: uncontrolled escape, spillage or leakage of a substance, gas, steam or pressurised substance',
  'Dangerous incident: fall or release from a height of any plant, substance or thing',
  'Dangerous incident: collapse, overturning or failure of plant, a structure, an excavation or shoring',
];

// ---------- Warning periods and status ----------

// Local (Sydney) calendar date as YYYY-MM-DD - toISOString() alone gives
// the UTC date, which is still yesterday before about 10am here.
function hrLocalDate(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function hrAddMonths(dateStr, months) {
  if (!dateStr) return null;
  const [y, m, day] = dateStr.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m + (months || 12), 0)).getUTCDate();   // e.g. 31 Aug + 6 months -> 28 Feb, not 3 Mar
  return new Date(Date.UTC(y, m - 1 + (months || 12), Math.min(day, lastDay))).toISOString().slice(0, 10);
}
function warningExpiry(w) { return hrAddMonths(w.issued_date, w.active_months || 12); }
// Live = still counts towards escalation: issued, not resolved or withdrawn,
// and inside its active period.
function warningIsLive(w) {
  if (!w || !['issued', 'acknowledged'].includes(w.status) || w.resolved_at) return false;
  const exp = warningExpiry(w);
  return !exp || hrLocalDate() < exp;
}
function warningDisplayStatus(w) {
  if (['issued', 'acknowledged'].includes(w.status) && !warningIsLive(w)) return 'Expired';
  return WARNING_STATUS_LABELS[w.status] || w.status;
}
function letterTitle(w) {
  return w.letter_type === 'counselling' ? 'Letter of counselling' : (WARNING_LEVEL_LABELS[w.warning_level] || 'Written warning');
}

// What happens if it isn't fixed - the default wording per level, used
// whenever the letter's own consequences field is left blank.
function defaultWarningConsequences(level, letterType) {
  if (letterType === 'counselling') {
    return 'We want you to succeed in your role and we will support you to get there. If the same concern continues after the review, it may need to be dealt with through the formal warning process.';
  }
  if (level === 'final') {
    return 'This is a final written warning. If there is any further instance of this or any other conduct or performance concern, the company is likely to terminate your employment.';
  }
  if (level === 'second') {
    return 'If the required improvement is not made and maintained, or there is any further concern, the company may take further disciplinary action, which may include a final written warning or the termination of your employment.';
  }
  return 'If the required improvement is not made and maintained, or there is any further concern, the company may take further disciplinary action, which may include further warnings or the termination of your employment.';
}

// ---------- Shared HTML bits ----------

function hrEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hrDate(d) {
  if (!d) return '';
  const dt = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T00:00:00') : new Date(d);
  return isNaN(dt) ? '' : dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}
function hrDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return isNaN(dt) ? '' : dt.toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
// Multi-line text, or a run of blank writing lines on a blank template.
function hrText(value, blankLines = 3) {
  if (value && String(value).trim()) return `<div class="filled">${hrEsc(value).replace(/\n/g, '<br>')}</div>`;
  return `<div class="lines">${'<div class="line"></div>'.repeat(blankLines)}</div>`;
}
function hrBox(checked) { return `<span class="box">${checked ? '&#10003;' : ''}</span>`; }
function hrYesNo(v) { return `Yes ${hrBox(v === true)} &nbsp; No ${hrBox(v === false)}`; }
// A saved signature only goes in an img when it is a PNG or JPEG data URL (the same rule as
// hrSafeSig in hr-shared.js, repeated here because letter.html loads this file without that one).
function hrSig(dataUrl) {
  const ok = typeof dataUrl === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(dataUrl);
  return ok ? `<img src="${dataUrl}" alt="signature" />` : '';
}

const HR_BASE_CSS = `
  @page { size: A4; margin: 16mm 15mm; }
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; font-size: 10.5pt; color: #111; line-height: 1.45; margin: 0; background: #fff; }
  .letterhead { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1d3a5f; padding-bottom: 10px; margin-bottom: 18px; gap: 12px; }
  .letterhead img { max-height: 54px; max-width: 220px; }
  .letterhead .co { text-align: right; font-size: 9pt; color: #444; }
  .letterhead .co strong { font-size: 10.5pt; color: #111; }
  h1 { font-size: 15pt; color: #1d3a5f; margin: 0 0 4px; letter-spacing: 0.02em; }
  h2 { font-size: 11pt; margin: 18px 0 6px; color: #1d3a5f; }
  h3 { font-size: 10.5pt; margin: 12px 0 4px; }
  p { margin: 0 0 8px; }
  .muted { color: #555; font-size: 9pt; }
  .lines .line { border-bottom: 1px solid #999; height: 22px; }
  .box { display: inline-block; width: 12px; height: 12px; border: 1px solid #333; vertical-align: -1px; text-align: center; font-size: 10px; line-height: 11px; }
  table.form { width: 100%; border-collapse: collapse; margin-bottom: 10px; page-break-inside: avoid; }
  table.form th { background: #a9c3cc; text-align: left; padding: 5px 7px; font-size: 10pt; border: 1px solid #555; }
  table.form td { border: 1px solid #555; padding: 5px 7px; vertical-align: top; font-size: 9.5pt; }
  table.form td.lbl { width: 28%; color: #333; }
  table.form.list td, table.form.list th { font-size: 9pt; }
  .sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; margin-top: 22px; page-break-inside: avoid; }
  .sig-block .sig-line { border-bottom: 1px solid #333; height: 48px; margin-bottom: 4px; display: flex; align-items: flex-end; }
  .sig-block .sig-line img, td img[alt="signature"] { max-height: 46px; max-width: 220px; }
  .sig-block .row { font-size: 9pt; margin-top: 10px; border-bottom: 1px solid #999; padding-bottom: 2px; min-height: 18px; }
  .confidential { font-weight: bold; letter-spacing: 0.08em; font-size: 9pt; margin-bottom: 12px; }
  .callout { border: 1px solid #1d3a5f; background: #eef3f8; padding: 8px 10px; border-radius: 4px; margin: 10px 0; font-size: 9.5pt; }
  .callout.red { border-color: #b3261e; background: #fbeceb; }
  .page-break { page-break-before: always; }
  .photos { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .photos figure { margin: 0; page-break-inside: avoid; }
  .photos img { width: 100%; max-height: 300px; object-fit: contain; border: 1px solid #ccc; }
  .photos figcaption { font-size: 8.5pt; color: #555; }
  .toolbar { position: fixed; top: 10px; right: 10px; }
  .toolbar button { font-size: 13px; padding: 8px 14px; cursor: pointer; }
  @media print { .toolbar { display: none; } }
  @media screen { body { max-width: 820px; margin: 0 auto; padding: 56px 20px 30px; } }
`;

function hrLetterhead(company) {
  const c = company || HR_COMPANY_FALLBACK;
  const name = c.company_name || HR_COMPANY_FALLBACK.company_name;
  return `<div class="letterhead">
    <div>${c.logo_url ? `<img src="${hrEsc(c.logo_url)}" alt="" />` : `<strong>${hrEsc(name)}</strong>`}</div>
    <div class="co"><strong>${hrEsc(name)}</strong><br>
      ${c.abn ? 'ABN ' + hrEsc(c.abn) + '<br>' : ''}${c.address ? hrEsc(c.address) + '<br>' : ''}${c.phone ? hrEsc(c.phone) : ''}</div>
  </div>`;
}

function hrDocument(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${hrEsc(title)}</title><style>${HR_BASE_CSS}</style></head>
    <body><div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>${bodyHtml}</body></html>`;
}

// ---------- Written warning / letter of counselling ----------

// w: a staff_warnings row (or {} for a blank warning). person: { full_name, job_title }.
function writtenWarningHtml(w = {}, person = {}, company = null) {
  const blank = !w.id;
  const counselling = w.letter_type === 'counselling';
  const level = w.warning_level || 'first';
  const levelLabel = blank ? 'First / Second / Final written warning' : letterTitle(w);
  const name = person.full_name || '';
  const firstName = name.split(' ')[0];
  const category = blank ? '' : (WARNING_CATEGORY_LABELS[w.category] || '');
  const meeting = w.meeting_date ? hrDate(w.meeting_date) : '____________________';
  const consequences = (w.consequences && w.consequences.trim()) || (blank ? '' : defaultWarningConsequences(level, w.letter_type));
  const companyName = (company && company.company_name) || HR_COMPANY_FALLBACK.company_name;
  const expiry = warningExpiry(w);
  let n = 0;
  const sec = (title) => `<h2>${++n}. ${title}</h2>`;

  const intro = counselling
    ? `<p>Thank you for meeting with ${w.issued_by_name ? hrEsc(w.issued_by_name) : 'me'} on ${meeting}${w.support_person ? `, with ${hrEsc(w.support_person)} as your support person` : ''}. This letter records what we talked about and the plan we agreed to help you. <strong>It is not a disciplinary warning.</strong></p>`
    : `<p>This letter confirms our meeting on ${meeting}${w.issued_by_name ? ` with ${hrEsc(w.issued_by_name)}` : ''}${w.support_person ? `, at which ${hrEsc(w.support_person)} attended as your support person` : ''}. At that meeting we raised the concerns set out below and gave you the opportunity to respond before any decision was made.</p>`;

  const body = `
    ${hrLetterhead(company)}
    <p class="confidential">PRIVATE AND CONFIDENTIAL</p>
    <p>${w.issued_date ? hrDate(w.issued_date) : 'Date: ____________________'}</p>
    <p>${name ? `<strong>${hrEsc(name)}</strong>` : 'Employee name: ________________________________'}<br>
      ${person.job_title ? hrEsc(person.job_title) : (blank ? 'Position: ________________________________' : '')}</p>

    <h1>${hrEsc(levelLabel.toUpperCase())}</h1>
    <p class="muted">${category ? 'About: ' + hrEsc(category) : 'About: Conduct / Performance / Safety / Attendance / Policy / Other'}${w.subject ? ' - ' + hrEsc(w.subject) : ''}</p>

    <p>Dear ${firstName ? hrEsc(firstName) : '____________'},</p>
    ${intro}

    ${sec(counselling ? 'What happened' : 'The concern')}
    ${w.incident_date ? `<p class="muted">Date: ${hrDate(w.incident_date)}</p>` : (blank ? '<p class="muted">Date of incident: ____________________</p>' : '')}
    ${hrText(w.details, 5)}

    ${sec(counselling ? 'The standard expected' : 'Policy, procedure or expectation not met')}
    ${hrText(w.policy_breached, 2)}

    ${counselling ? '' : `${sec('Previous discussions')}${hrText(w.previous_discussions || (blank ? '' : 'None recorded.'), 2)}`}

    ${sec(counselling ? 'Your comments' : 'Your response')}
    ${hrText(w.employee_response, 3)}

    ${counselling ? '' : `${sec('Outcome')}
    <p>Having considered your response, the company has decided to issue you with this <strong>${hrEsc(blank ? 'first / second / final written warning' : levelLabel.toLowerCase())}</strong>.</p>`}

    ${sec(counselling ? 'The plan' : 'What is expected of you')}
    ${hrText(w.expected_improvement, 3)}

    ${sec('Support the company will provide')}
    ${hrText(w.support_offered, 2)}

    ${sec('Review')}
    <p>${w.review_date ? `We will review your progress with you on or around <strong>${hrDate(w.review_date)}</strong>.` : 'Review date: ____________________'}</p>
    ${!counselling ? `<p>${expiry ? `This warning will remain active for ${w.active_months || 12} months, until <strong>${hrDate(expiry)}</strong>.` : 'This warning will remain active for ______ months.'} If the improvement is made and maintained, the matter will be recorded as resolved.</p>` : ''}

    ${sec(counselling ? 'Going forward' : 'Consequences')}
    ${hrText(consequences, 2)}

    <p style="margin-top:14px;">A copy of this letter will be kept on your personnel file. You may respond in writing (or in the comments below), and your response will be kept with it. If you have any questions, or believe anything in this letter is inaccurate, please raise it with ${w.issued_by_name ? hrEsc(w.issued_by_name) : 'your manager'}.</p>
    <p>Yours sincerely,</p>

    <div class="sig-grid">
      <div class="sig-block">
        <div class="sig-line">${hrSig(w.manager_signature_data_url)}</div>
        <div class="row">Name: ${hrEsc(w.issued_by_name || '')}</div>
        <div class="row">Position: ${hrEsc(w.issued_by_position || '')}</div>
        <div class="row">Date: ${w.manager_signed_at ? hrDate(w.manager_signed_at) : ''}</div>
        <p class="muted">For and on behalf of ${hrEsc(companyName)}</p>
      </div>
      <div class="sig-block">
        <div class="sig-line">${hrSig(w.employee_signature_data_url)}</div>
        <div class="row">Employee: ${hrEsc(w.employee_signed_name || name)}</div>
        <div class="row">Date: ${w.employee_signed_at ? hrDateTime(w.employee_signed_at) + (w.employee_signed_how === 'in_app' ? ' (signed in the app)' : '') : ''}</div>
        <p class="muted">I acknowledge I have received and read this letter. Signing it does not mean I agree with its contents.</p>
      </div>
    </div>
    <div class="sig-grid">
      <div class="sig-block">
        <div class="sig-line">${hrSig(w.witness_signature_data_url)}</div>
        <div class="row">Witness / support person: ${hrEsc(w.support_person || '')}</div>
        <div class="row">Date: ${w.witness_signed_at ? hrDate(w.witness_signed_at) : ''}</div>
      </div>
      <div class="sig-block">
        <p style="margin-top:20px;">${hrBox(w.refused_to_sign)} Employee declined to sign (witness to sign and date)</p>
      </div>
    </div>

    <h2>Employee comments (optional)</h2>
    ${hrText(w.employee_comments, 5)}
    ${w.status === 'resolved' && w.resolved_at ? `<div class="callout">Resolved on ${hrDate(w.resolved_at)}${w.resolved_note ? ': ' + hrEsc(w.resolved_note) : ''}</div>` : ''}
  `;
  return hrDocument(`${levelLabel}${name ? ' - ' + name : ''}`, body);
}

// The "this matter is now closed" letter for a resolved warning or counselling letter.
function resolutionLetterHtml(w, person = {}, company = null) {
  const name = person.full_name || '';
  const firstName = name.split(' ')[0];
  const body = `
    ${hrLetterhead(company)}
    <p class="confidential">PRIVATE AND CONFIDENTIAL</p>
    <p>${hrDate(w.resolved_at || hrLocalDate())}</p>
    <p><strong>${hrEsc(name)}</strong><br>${hrEsc(person.job_title || '')}</p>
    <h1>MATTER RESOLVED</h1>
    <p class="muted">${hrEsc(letterTitle(w))} dated ${hrDate(w.issued_date)}${w.subject ? ' - ' + hrEsc(w.subject) : ''}</p>
    <p>Dear ${hrEsc(firstName || name)},</p>
    <p>Thank you for the effort you have put in since we met about the matter above. We have reviewed your progress and are pleased to confirm that it is now <strong>resolved</strong>.</p>
    ${w.resolved_note ? `<p>${hrEsc(w.resolved_note).replace(/\n/g, '<br>')}</p>` : ''}
    <p>${w.letter_type === 'counselling' ? 'The letter of counselling stays on your file as a record of the support provided, but no further action will be taken on it.' : 'The warning stays on your file as a record, but it is no longer active and will not be used to step up any future disciplinary action.'}</p>
    <p>Thank you, and please keep coming to us if you need any support.</p>
    <p>Yours sincerely,</p>
    <div class="sig-grid"><div class="sig-block">
      <div class="sig-line"></div>
      <div class="row">Name: ${hrEsc(w.resolved_by_name || w.issued_by_name || '')}</div>
      <p class="muted">For and on behalf of ${hrEsc((company && company.company_name) || HR_COMPANY_FALLBACK.company_name)}</p>
    </div></div>`;
  return hrDocument(`Matter resolved - ${name}`, body);
}

// ---------- Incident and injury report (WHS Form 10) ----------

function incidentRef(r) { return r.incident_number ? 'INC-' + String(r.incident_number).padStart(4, '0') : ''; }

function hrTime12(t) {
  if (!t) return { label: '', am: null };
  const [hh, mm] = String(t).slice(0, 5).split(':').map(Number);
  return { label: `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')}`, am: hh < 12 };
}

// The Form 10 tables themselves. people: incident_people rows (witnesses
// are taken from there); falls back to the legacy witnesses jsonb.
function incidentForm10Body(r = {}, people = []) {
  const t = hrTime12(r.incident_time);
  const amPm = `am ${hrBox(t.am === true)} &nbsp; pm ${hrBox(t.am === false)}`;
  const cell = (v) => hrEsc(v || '');
  const fromPeople = people.filter(p => p.role === 'witness').map(p => ({ name: p.name, contact: p.contact }));
  const listed = fromPeople.length ? fromPeople : (r.witnesses || []);
  const witnesses = listed.concat([{}, {}]).slice(0, Math.max(2, listed.length));
  const locs = r.body_locations || [];
  const n = r.nature;

  return `
    <table class="form">
      <tr><th colspan="4">Details of injury (eg to a worker or visitor) and treatment</th></tr>
      <tr><td class="lbl">Date of incident</td><td>${hrDate(r.incident_date)}</td><td class="lbl">Time of incident</td><td>${t.label} &nbsp; ${amPm}</td></tr>
      <tr><td class="lbl">Nature of incident</td><td colspan="3">${hrBox(n === 'near_miss')} Near miss &nbsp;&nbsp; ${hrBox(n === 'first_aid')} First aid &nbsp;&nbsp; ${hrBox(n === 'medical_treatment' || n === 'lost_time')} Medical treatment/doctor${n === 'lost_time' ? ' (lost time)' : ''} &nbsp;&nbsp; ${hrBox(n === 'dangerous_incident')} Dangerous incident &nbsp;&nbsp; ${hrBox(n === 'property_damage')} Property damage only</td></tr>
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
      <tr><td class="lbl">Date of incident</td><td>${hrDate(r.incident_date)}</td><td class="lbl">Time of incident</td><td>${t.label} &nbsp; ${amPm}</td></tr>
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
      <tr><td class="lbl">Reported to authorities (SafeWork NSW phone: <strong>13 10 50</strong>)?<br>${hrYesNo(r.reported_safework)}</td><td>Provide details (when, reported to and reported by):<br>${cell(r.reported_safework_details)}${r.safework_reference ? '<br>SafeWork reference: ' + cell(r.safework_reference) : ''}</td></tr>
      <tr><td class="lbl">Reported to workers compensation insurer?<br>${hrYesNo(r.reported_insurer)}</td><td>Provide details (name of insurer and claim number):<br>${cell(r.reported_insurer_details || [r.wc_insurer, r.wc_claim_number && 'Claim ' + r.wc_claim_number].filter(Boolean).join(', '))}</td></tr>
    </table>

    <table class="form">
      <tr><th colspan="4">Completed by</th></tr>
      <tr><td class="lbl">Name</td><td>${cell(r.completed_by_name)}</td><td class="lbl">Position</td><td>${cell(r.completed_by_position)}</td></tr>
      <tr><td class="lbl">Signature</td><td style="height:48px;">${hrSig(r.completed_signature_data_url)}</td><td class="lbl">Date</td><td>${hrDate(r.completed_date)}</td></tr>
    </table>`;
}

function incidentReportHtml(r = {}, company = null, people = []) {
  const body = `
    ${hrLetterhead(company)}
    <h1>WHS FORM 10: INCIDENT AND INJURY REPORT</h1>
    <p class="muted">Based on the SafeWork NSW Housing Industry Site Safety Pack, Form 10.${incidentRef(r) ? ' Reference ' + incidentRef(r) : ''}</p>
    ${incidentForm10Body(r, people)}
    <p class="muted">Serious injuries, illnesses and dangerous incidents are notifiable to SafeWork NSW immediately on 13 10 50. Keep the site undisturbed until an inspector says otherwise. Keep this record for at least 5 years.</p>`;
  return hrDocument(`Incident report${incidentRef(r) ? ' ' + incidentRef(r) : ''}${r.incident_date ? ' - ' + r.incident_date : ''}`, body);
}

// Everything about one incident in a single document, for a workers comp
// claim, SafeWork, a principal contractor, or the internal file.
// opts: { r, people, actions, files (each with .url for photos), warnings,
// staffById, project, company, includeHr }
function incidentPackHtml(opts) {
  const { r, people = [], actions = [], files = [], warnings = [], staffById = {}, project = null, company = null, includeHr = false } = opts;
  const cell = (v) => hrEsc(v || '');
  const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : '-');
  const photos = files.filter(f => f.kind === 'photo' && f.url);
  const docs = files.filter(f => f.kind !== 'photo');
  const ref = incidentRef(r);

  const body = `
    ${hrLetterhead(company)}
    <h1>INCIDENT FILE ${hrEsc(ref)}</h1>
    <p class="muted">Prepared ${hrDate(hrLocalDate())}${includeHr ? ' &middot; Internal copy, includes HR records' : ''}</p>

    <table class="form">
      <tr><th colspan="4">Summary</th></tr>
      <tr><td class="lbl">What happened</td><td colspan="3">${cell(r.title)}</td></tr>
      <tr><td class="lbl">Type</td><td>${cell(INCIDENT_NATURE_LABELS[r.nature])}</td><td class="lbl">Status</td><td>${r.status === 'closed' ? 'Closed' : 'Open'}</td></tr>
      <tr><td class="lbl">Date and time</td><td>${hrDate(r.incident_date)} ${hrTime12(r.incident_time).label}${r.incident_time ? (hrTime12(r.incident_time).am ? ' am' : ' pm') : ''}</td><td class="lbl">Job</td><td>${project ? cell((project.job_number ? 'J' + project.job_number + ' - ' : '') + project.name) : '-'}</td></tr>
      <tr><td class="lbl">Location</td><td colspan="3">${cell(r.site_location)}</td></tr>
      <tr><td class="lbl">Notifiable to SafeWork?</td><td colspan="3">${yn(r.notifiable)}${(r.notifiable_categories || []).length ? '<br>' + r.notifiable_categories.map(hrEsc).join('<br>') : ''}${r.safework_notified_at ? `<br>Notified ${hrDateTime(r.safework_notified_at)}` : ''}${r.safework_reference ? ` &middot; reference ${cell(r.safework_reference)}` : ''}</td></tr>
      <tr><td class="lbl">Workers compensation</td><td colspan="3">${r.wc_required === true ? `Claim ${r.wc_claim_number ? cell(r.wc_claim_number) : '(number not yet issued)'}${r.wc_insurer ? ', ' + cell(r.wc_insurer) : ''}${r.wc_policy_number ? ', policy ' + cell(r.wc_policy_number) : ''}${r.wc_insurer_notified_at ? `<br>Insurer notified ${hrDateTime(r.wc_insurer_notified_at)}` : ''}${r.wc_claim_status ? '<br>Status: ' + cell(r.wc_claim_status) : ''}${r.wc_days_off != null ? '<br>Days off work: ' + cell(r.wc_days_off) : ''}${r.wc_return_to_work_date ? '<br>Return to work: ' + hrDate(r.wc_return_to_work_date) : ''}${r.wc_notes ? '<br>' + cell(r.wc_notes) : ''}` : yn(r.wc_required)}</td></tr>
    </table>

    <h2>People involved</h2>
    <table class="form list">
      <tr><th>Name</th><th>Role</th><th>Contact</th><th>Their part</th><th>Finding</th></tr>
      ${people.map(p => `<tr><td>${cell(p.name)}${p.profile_id ? '' : '<br><span class="muted">not staff</span>'}</td><td>${cell(INCIDENT_ROLE_LABELS[p.role])}</td><td>${cell(p.contact)}</td>
        <td>${cell(p.what_happened)}</td><td>${p.at_fault ? '<strong>Contributing fault.</strong> ' : ''}${cell(p.finding)}${p.procedure_breached ? '<br><span class="muted">Procedure: ' + cell(p.procedure_breached) + '</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="5">None recorded.</td></tr>'}
    </table>

    ${people.filter(p => p.statement).map(p => `
      <h3>Statement: ${cell(p.name)} (${cell(INCIDENT_ROLE_LABELS[p.role])})</h3>
      <div>${hrText(p.statement)}</div>
      ${p.statement_signature_data_url ? `<p>${hrSig(p.statement_signature_data_url)}<br><span class="muted">Signed ${hrDateTime(p.statement_signed_at)}</span></p>` : ''}`).join('')}

    <h2>Investigation</h2>
    <table class="form">
      <tr><td class="lbl">Root cause</td><td>${r.root_cause ? cell(r.root_cause).replace(/\n/g, '<br>') : '-'}</td></tr>
      <tr><td class="lbl">Findings</td><td>${r.investigation_findings ? cell(r.investigation_findings).replace(/\n/g, '<br>') : '-'}</td></tr>
    </table>

    <h2>Corrective actions</h2>
    <table class="form list">
      <tr><th>Action</th><th>Who</th><th>Due</th><th>Done</th></tr>
      ${actions.map(a => `<tr><td>${cell(a.description)}${a.notes ? '<br><span class="muted">' + cell(a.notes) + '</span>' : ''}</td><td>${cell(staffById[a.assigned_to])}</td><td>${hrDate(a.due_date)}</td><td>${a.done_at ? hrDate(a.done_at) : 'Open'}</td></tr>`).join('') || '<tr><td colspan="4">None recorded.</td></tr>'}
    </table>

    ${includeHr ? `
      <h2>Warnings and letters arising</h2>
      <table class="form list">
        <tr><th>Employee</th><th>Letter</th><th>Date</th><th>Status</th></tr>
        ${warnings.map(w => `<tr><td>${cell(staffById[w.profile_id])}</td><td>${cell(letterTitle(w))}${w.subject ? ': ' + cell(w.subject) : ''}</td><td>${hrDate(w.issued_date)}</td><td>${cell(warningDisplayStatus(w))}</td></tr>`).join('') || '<tr><td colspan="4">None.</td></tr>'}
      </table>` : ''}

    <h2>Evidence</h2>
    <table class="form list">
      <tr><th>Document</th><th>Category</th><th>Added</th></tr>
      ${docs.map(f => `<tr><td>${cell(f.title || f.file_name)}</td><td>${cell(f.category)}</td><td>${hrDate(f.created_at)}</td></tr>`).join('') || '<tr><td colspan="3">No documents attached.</td></tr>'}
    </table>
    <p class="muted">${photos.length} photo${photos.length === 1 ? '' : 's'} attached. Documents are included in the zip download from the app.</p>

    <div class="page-break"></div>
    <h1>WHS FORM 10: INCIDENT AND INJURY REPORT</h1>
    <p class="muted">${ref ? 'Reference ' + ref : ''}</p>
    ${incidentForm10Body(r, people)}

    ${photos.length ? `<div class="page-break"></div><h1>PHOTOS</h1>
      <div class="photos">${photos.map(f => `<figure><img src="${hrEsc(f.url)}" alt="" /><figcaption>${cell(f.title || f.file_name)} &middot; ${hrDate(f.created_at)}</figcaption></figure>`).join('')}</div>` : ''}
  `;
  return hrDocument(`Incident file ${ref}`, body);
}

// ---------- Showing and printing ----------

function printHrDocument(html) {
  const win = window.open('', '_blank');
  if (!win) { alert('Your browser blocked the new window - allow pop-ups for this site and try again.'); return; }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.onload = () => setTimeout(() => win.print(), 300);
}

// Shows a document inside the app (no download), with its own print button.
// extraButtonsHtml goes in the top bar; returns the overlay for wiring them.
function showHrDocument(html, title, extraButtonsHtml = '') {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:200; display:flex; flex-direction:column; padding:12px; gap:8px;';
  overlay.innerHTML = `
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; max-width:900px; width:100%; margin:0 auto;">
      <strong style="color:#fff; flex:1; min-width:160px;">${hrEsc(title || '')}</strong>
      ${extraButtonsHtml}
      <button type="button" class="secondary hrdoc-print">Print / PDF</button>
      <button type="button" class="secondary hrdoc-close">Close</button>
    </div>
    <iframe style="flex:1; width:100%; max-width:900px; margin:0 auto; border:0; border-radius:8px; background:#fff;"></iframe>`;
  document.body.appendChild(overlay);
  const frame = overlay.querySelector('iframe');
  frame.srcdoc = html.replace('<div class="toolbar">', '<div class="toolbar" style="display:none">');
  overlay.querySelector('.hrdoc-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.hrdoc-print').addEventListener('click', () => frame.contentWindow.print());
  return overlay;
}

// Drawn signature pad (same approach as onboarding.html). Returns
// { isEmpty(), toDataURL(), clear() }.
function createSignaturePad(container, height = 140) {
  container.innerHTML = `
    <canvas width="460" height="${height}" style="border:1px solid var(--border); border-radius:8px; background:#fff; touch-action:none; width:100%; max-width:460px; height:${height}px; display:block;"></canvas>
    <button type="button" class="secondary" style="font-size:12px; padding:5px 10px; margin-top:6px;">Clear signature</button>`;
  const canvas = container.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
  let drawing = false, empty = true;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) }; };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; empty = false; canvas.setPointerCapture(e.pointerId); const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
  canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
  canvas.addEventListener('pointerup', () => { drawing = false; });
  canvas.addEventListener('pointercancel', () => { drawing = false; });
  const clear = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); empty = true; };
  container.querySelector('button').addEventListener('click', clear);
  return { isEmpty: () => empty, toDataURL: () => canvas.toDataURL('image/png'), clear };
}
