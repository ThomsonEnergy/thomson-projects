// Booking emails to the client and the bits every schedule function shares. The texts end
// without a sign off: the sender's "Kind regards" and signature are added on sending.
// (docs/PROJECT_SPEC.md A34): who the email goes to, how dates and times read, the email
// texts, and the staff notification for a moved or cancelled booking.

const SYD = 'Australia/Sydney';
const sydneyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: SYD });
const fmtDay = (ymd) => new Date(ymd + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
const fmtTime = (t) => {
  const [h, m] = String(t || '').split(':').map(Number);
  if (Number.isNaN(h)) return String(t || '');
  const ap = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m || 0).padStart(2, '0')}${ap}`;
};
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const jobRef = (p) => (p.job_number ? `J${p.job_number}` : p.quote_number ? `Q${p.quote_number}` : '');
const jobTitle = (p) => [jobRef(p), p.name].filter(Boolean).join(' ');
const firstName = (s) => (String(s || '').trim().split(/\s+/)[0] || 'there');
const listNames = (names) => {
  const n = [...new Set(names.filter(Boolean))];
  if (!n.length) return '';
  if (n.length === 1) return n[0];
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};

// "Tue 21 Oct, 7:00am to 3:30pm", or "Tue 21 Oct to Fri 24 Oct, 7:00am to 3:30pm" for a run of
// days at the same times (weekends in between are skipped the way bookings skip them).
function whenLines(rows) {
  const days = new Map();
  for (const r of rows) {
    const key = `${r.assignment_date}|${String(r.start_time).slice(0, 5)}|${String(r.end_time).slice(0, 5)}`;
    if (!days.has(key)) days.set(key, { date: r.assignment_date, start: String(r.start_time).slice(0, 5), end: String(r.end_time).slice(0, 5) });
  }
  const list = [...days.values()].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const lines = [];
  let i = 0;
  while (i < list.length) {
    let j = i;
    // a run is day after day, or Friday straight to Monday (a weekday job skipping the weekend)
    const joins = (k) => list[k + 1].date === addDays(list[k].date, 1) || (new Date(list[k].date + 'T00:00:00Z').getUTCDay() === 5 && list[k + 1].date === addDays(list[k].date, 3));
    while (j + 1 < list.length && list[j + 1].start === list[i].start && list[j + 1].end === list[i].end && joins(j)) j += 1;
    const times = `${fmtTime(list[i].start)} to ${fmtTime(list[i].end)}`;
    lines.push(j > i ? `${fmtDay(list[i].date)} to ${fmtDay(list[j].date)}, ${times}` : `${fmtDay(list[i].date)}, ${times}`);
    i = j + 1;
  }
  return lines;
}

// The job's own client-side contact with an email (Contacts tab: job contact, then site manager,
// then project manager), else the old job contact link, else the client email on the job.
const CLIENT_ROLE_ORDER = ['job_contact', 'site_manager', 'project_manager'];
const CLIENT_ROLE_SOURCE = { job_contact: 'job contact', site_manager: 'client site manager', project_manager: 'client project manager' };
async function recipientFor(admin, project) {
  const { data: contacts } = await admin.from('job_contacts').select('role, name, email').eq('project_id', project.id).eq('side', 'client');
  const pick = (contacts || []).filter((c) => c.email && c.email.trim() && CLIENT_ROLE_ORDER.includes(c.role))
    .sort((a, b) => CLIENT_ROLE_ORDER.indexOf(a.role) - CLIENT_ROLE_ORDER.indexOf(b.role))[0];
  if (pick) return { to: pick.email.trim(), name: pick.name || project.client_name || '', first: firstName(pick.name || project.client_name), source: CLIENT_ROLE_SOURCE[pick.role] };
  if (project.job_contact_id) {
    const { data: c } = await admin.from('client_contacts').select('name, email').eq('id', project.job_contact_id).maybeSingle();
    if (c && c.email) return { to: c.email, name: c.name || project.client_name || '', first: firstName(c.name || project.client_name), source: 'job contact' };
  }
  if (project.client_email) return { to: project.client_email, name: project.client_name || '', first: firstName(project.client_name), source: 'client' };
  return { to: '', name: project.client_name || '', first: firstName(project.client_name), source: 'none' };
}

async function companyPhone(admin) {
  const { data } = await admin.from('company_settings').select('phone').eq('id', 1).maybeSingle();
  return (data && data.phone) || '0455 415 464';
}

// Everyone booked on the job for those dates (full names), newest booking first is not needed: alphabetical.
async function whoOn(admin, projectId, dates) {
  if (!dates.length) return [];
  const { data } = await admin.from('schedule_assignments').select('staff_id, profiles(full_name)').eq('project_id', projectId).in('assignment_date', dates);
  return [...new Set((data || []).map((r) => r.profiles && r.profiles.full_name).filter(Boolean))].sort();
}
async function namesFor(admin, staffIds) {
  if (!staffIds.length) return [];
  const { data } = await admin.from('profiles').select('full_name').in('id', staffIds).order('full_name');
  return (data || []).map((p) => p.full_name).filter(Boolean);
}

const closeLine = (phone) => `If that doesn't suit, reply to this email or call ${phone}.`;

function bookingConfirmedBody({ first, project, rows, who, phone }) {
  return [
    `Hi ${first},`,
    '',
    `We've booked you in for ${jobTitle(project)}.`,
    '',
    `When: ${whenLines(rows).join('\n      ')}`,
    `Where: ${project.client_address || '[site address]'}`,
    who.length ? `Who: ${listNames(who)}` : null,
    '',
    closeLine(phone),
  ].filter((l) => l !== null).join('\n');
}

function bookingMovedBody({ first, project, oldRows, newRows, who, phone }) {
  return [
    `Hi ${first},`,
    '',
    `We've had to move your booking for ${jobTitle(project)}.`,
    '',
    `New time: ${whenLines(newRows).join('\n          ')}`,
    `Was: ${whenLines(oldRows).join('\n     ')}`,
    `Where: ${project.client_address || '[site address]'}`,
    who.length ? `Who: ${listNames(who)}` : null,
    '',
    'Sorry for the change.',
    closeLine(phone),
  ].filter((l) => l !== null).join('\n');
}

function bookingCancelledBody({ first, project, oldRows, phone, withOptions }) {
  return [
    `Hi ${first},`,
    '',
    `We've had to cancel your booking for ${jobTitle(project)} on ${whenLines(oldRows).join(' and ')}.`,
    '',
    withOptions
      ? 'Sorry about that. Below are some times that work for us, pick whichever suits you and we will lock it in.'
      : `Sorry about that. We'll be in touch with new times, or reply to this email or call ${phone} to arrange one.`,
  ].join('\n');
}

// The options as the client reads them: "Tue 21 Oct" or "Tue 21 Oct to Wed 22 Oct".
function optionLabel(startDate, days, weekdaysOnly) {
  const dates = optionDates(startDate, days, weekdaysOnly);
  return dates.length > 1 ? `${fmtDay(dates[0])} to ${fmtDay(dates[dates.length - 1])}` : fmtDay(dates[0]);
}
function optionDates(startDate, days, weekdaysOnly) {
  const out = [];
  let d = startDate;
  while (out.length < Math.max(1, days)) {
    if (!(weekdaysOnly && [0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay()))) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

function timeOfferBody({ first, project, start, end, days, weekdaysOnly, optionDatesList, who, message, phone }) {
  const times = `${fmtTime(start)} to ${fmtTime(end)}${days > 1 ? `, ${days} days` : ''}`;
  return [
    `Hi ${first},`,
    '',
    `Here are some times that work for us for ${jobTitle(project)} (${times}):`,
    '',
    ...optionDatesList.map((d) => `- ${optionLabel(d, days, weekdaysOnly)}`),
    '',
    message ? `${message}\n` : null,
    'Tap the button below to pick the one that suits you. If none of them work, you can tell us there too.',
    who.length ? `${listNames(who)} would be doing the work at ${project.client_address || '[site address]'}.` : null,
    '',
    `Any questions, reply to this email or call ${phone}.`,
  ].filter((l) => l !== null).join('\n');
}

function timeOfferPickedBody({ first, project, rows, who, phone }) {
  return [
    `Hi ${first},`,
    '',
    `Thanks, you're booked in for ${jobTitle(project)}.`,
    '',
    `When: ${whenLines(rows).join('\n      ')}`,
    `Where: ${project.client_address || '[site address]'}`,
    who.length ? `Who: ${listNames(who)}` : null,
    '',
    `If anything changes, reply to this email or call ${phone}.`,
  ].filter((l) => l !== null).join('\n');
}

const subjectFor = (kind, project) => ({
  booking_confirmed: `Booking confirmed: ${jobTitle(project)}`,
  booking_moved: `Booking moved: ${jobTitle(project)}`,
  booking_cancelled: `Booking cancelled: ${jobTitle(project)}`,
  time_offer: `Pick a time: ${jobTitle(project)}`,
  time_offer_picked: `Booking confirmed: ${jobTitle(project)}`,
}[kind] || jobTitle(project));

// Staff see bookings in My Day; a move or cancel still deserves a phone notification.
async function notifyStaff(admin, rows, { title, body, actorId }) {
  for (const r of rows) {
    await admin.rpc('create_notification', {
      p_user: r.staff_id, p_kind: 'scheduled', p_title: title, p_body: body, p_link: '/my-day.html', p_actor: actorId || null,
      p_dedupe: `sched-change:${r.id}:${Date.now()}`,
    });
  }
}

module.exports = {
  sydneyToday, fmtDay, fmtTime, addDays, jobRef, jobTitle, firstName, listNames, whenLines, optionDates, optionLabel,
  recipientFor, companyPhone, whoOn, namesFor, subjectFor, notifyStaff,
  bookingConfirmedBody, bookingMovedBody, bookingCancelledBody, timeOfferBody, timeOfferPickedBody,
};
