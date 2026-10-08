// Prompt building and answer checking for the meeting AI pass
// (analyze-meeting-background.js). Kept separate so it can be tested on its
// own without Netlify, Supabase or the Anthropic API.
//
// The model only ever sees the handful of jobs someone linked to the
// meeting (never the whole job list), numbered 1..N, and answers using those
// numbers. Everything it returns is checked here: a job number that is not in
// the list becomes "no job", a person that is not a real staff member
// becomes "nobody", and a date that is not a real date becomes "no date" -
// so a confused answer can never point at the wrong record, only at nothing.

const MAX_TRANSCRIPT_CHARS = 180000;

function fmtClock(ms) {
  const total = Math.floor((ms || 0) / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

function weekdayName(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-AU', { weekday: 'long', timeZone: 'UTC' });
}

function jobLabel(p) {
  const ref = p.job_number ? `J${p.job_number}` : (p.quote_number ? `Q${p.quote_number}` : 'no number');
  return `${ref} - ${p.name}`;
}

function buildPrompt({ meeting, jobs, staff, transcript }) {
  const attendeeIds = new Set(meeting.attendee_ids || []);
  const staffLines = staff.map(s => `- ${s.full_name} (id ${s.id})${attendeeIds.has(s.id) ? ' [was at this meeting]' : ''}`).join('\n');
  const jobLines = jobs.length ? jobs.map((j, n) => {
    const desc = String(j.installer_summary || j.sow_text || j.notes || '').replace(/\s+/g, ' ').slice(0, 500);
    return `JOB ${n + 1}: ${jobLabel(j)}\n  Client: ${j.client_name || 'unknown'}${j.client_address ? ', ' + j.client_address : ''}\n  Stage: ${j.pipeline_stage || 'unknown'}${desc ? '\n  About: ' + desc : ''}${j.open_tasks && j.open_tasks.length ? '\n  Open tasks already on the job: ' + j.open_tasks.join('; ') : ''}`;
  }).join('\n') : '(no jobs were linked to this meeting)';

  let lines = transcript.map(u => `[#${u.i} ${u.speaker} ${fmtClock(u.start)}] ${u.text}`).join('\n');
  if (lines.length > MAX_TRANSCRIPT_CHARS) lines = lines.slice(0, MAX_TRANSCRIPT_CHARS) + '\n[transcript cut short]';

  const date = meeting.meeting_date;
  return `You are helping an Australian electrical and solar contractor (Thomson Energy) write up a team meeting from a speaker-labelled transcript. Speaker letters (A, B, C...) come from automatic speaker detection and are sometimes wrong, so use what people say (names they use, who is addressed, who answers) to decide who is who.

Meeting: "${meeting.title}", held ${weekdayName(date)} ${date} (Australia/Sydney).

STAFF (the only people tasks can be given to):
${staffLines}

JOBS DISCUSSED (the only jobs you may refer to, use their numbers):
${jobLines}

TRANSCRIPT:
${lines}

Return ONE JSON object and nothing else (no markdown fences) with exactly these keys:
{
  "speakers": [ { "label": "A", "staff_id": "<id from the STAFF list or null if not staff or unsure>", "name": "<best guess at their name, or null>", "confidence": "high|medium|low", "reason": "<one short sentence of evidence>" } ],
  "summary": "<2-4 plain sentences on what the meeting covered>",
  "notes": [ { "job": <JOB number or null for general topics>, "heading": "<short heading>", "points": ["<what was discussed or decided>"] } ],
  "actions": [ {
    "description": "<clear task starting with a verb, written so someone reading only the job's task list understands it>",
    "job": <JOB number this is for, or null if it is not about one of the listed jobs>,
    "assignee_speaker": "<speaker label of the person who said they would do it, or who agreed when asked, or null>",
    "assignee_staff_id": "<id from the STAFF list if you can tell who is doing it, else null>",
    "due_date": "<YYYY-MM-DD if a day was said or clearly implied, else null>",
    "due_text": "<the words used about timing, e.g. 'by Friday', or null>",
    "utterance": <the # number of the line that best backs this up>,
    "quote": "<a short verbatim snippet from the transcript backing it up>",
    "confidence": "high|medium|low"
  } ]
}

Rules:
- Only list an action when somebody clearly committed to it, was asked to do it and agreed, or it was plainly decided that something must be done. Do not invent work, and do not turn general discussion into tasks.
- Assign it to the person who took it on. If someone is told "Cooper, can you chase that?" and Cooper agrees, it is Cooper's. If it is unclear who owns it, leave the assignee empty rather than guessing.
- Turn relative dates into real dates using the meeting date above ("Friday" is the next Friday on or after the meeting, "end of the week" is that Friday, "next week" with no day is null with due_text). If you are not sure, use null and put the words in due_text.
- Link each action and note to the right JOB only when the conversation was about it. Use clues like the client name, street or suburb, job type and what each job involves. If it genuinely fits none of them, use null.
- Correct obvious speech-to-text mistakes in names, streets and equipment using the staff and job details above.
- Keep each action to one task. Keep the notes factual and short. Australian English. Do not use em dashes.`;
}

function extractJson(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI reply was not in the expected format');
  return JSON.parse(text.slice(start, end + 1));
}

const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const level = (c) => (['high', 'medium', 'low'].includes(c) ? c : 'low');

// Turn the model's answer into the draft the review screen works on.
function buildDraft(raw, { jobs, staff, transcript }) {
  const parsed = extractJson(raw);
  const staffIds = new Set(staff.map(s => s.id));
  const labels = [...new Set(transcript.map(u => u.speaker))];
  const jobId = (n) => (Number.isInteger(n) && n >= 1 && n <= jobs.length ? jobs[n - 1].id : null);

  const speakers = {};
  labels.forEach(l => { speakers[l] = { staff_id: null, name: null, confidence: 'low', reason: '' }; });
  const used = new Set();
  (parsed.speakers || []).forEach(s => {
    if (!s || !speakers[s.label]) return;
    const sid = staffIds.has(s.staff_id) && !used.has(s.staff_id) ? s.staff_id : null;
    if (sid) used.add(sid);
    speakers[s.label] = { staff_id: sid, name: sid ? staff.find(x => x.id === sid).full_name : (s.name || null), confidence: level(s.confidence), reason: String(s.reason || '').slice(0, 200) };
  });

  const noteBlocks = [];
  (parsed.notes || []).forEach(n => {
    if (!n || !Array.isArray(n.points) || !n.points.length) return;
    const j = jobId(n.job);
    const head = (j ? jobLabel(jobs[n.job - 1]) + ': ' : '') + String(n.heading || (j ? 'Discussion' : 'General')).trim();
    noteBlocks.push(`## ${head}\n` + n.points.map(p => `- ${String(p).trim()}`).join('\n'));
  });
  const summary = String(parsed.summary || '').trim();
  const notesText = [summary, ...noteBlocks].filter(Boolean).join('\n\n');

  const maxUtterance = transcript.length ? transcript[transcript.length - 1].i : 0;
  const actions = [];
  (parsed.actions || []).forEach((a, n) => {
    if (!a || !String(a.description || '').trim()) return;
    const speaker = speakers[a.assignee_speaker] ? a.assignee_speaker : null;
    let staffId = staffIds.has(a.assignee_staff_id) ? a.assignee_staff_id : null;
    // if the model named a speaker but no staff id, use who that speaker is
    if (!staffId && speaker && speakers[speaker].staff_id) staffId = speakers[speaker].staff_id;
    actions.push({
      id: 'a' + (n + 1),
      include: true,
      description: String(a.description).trim().slice(0, 300),
      project_id: jobId(a.job),
      assignee_speaker: speaker,
      assignee_id: staffId,
      due_date: validDate(a.due_date) ? a.due_date : null,
      due_text: a.due_text ? String(a.due_text).slice(0, 80) : null,
      utterance: Number.isInteger(a.utterance) && a.utterance >= 0 && a.utterance <= maxUtterance ? a.utterance : null,
      quote: a.quote ? String(a.quote).slice(0, 300) : '',
      confidence: level(a.confidence),
    });
  });

  return { version: 1, speakers, utterance_speakers: {}, notes_text: notesText, actions, job_ids: jobs.map(j => j.id), generated_at: new Date().toISOString() };
}

module.exports = { buildPrompt, buildDraft, extractJson, fmtClock, jobLabel };
