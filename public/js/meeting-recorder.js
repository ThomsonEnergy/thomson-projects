// Meeting recording + AI write-up (used by meetings.html).
//
// Flow: record (or upload / paste) -> transcript with speakers -> AI drafts
// notes and per-job follow-up actions -> a person checks and fixes the draft
// -> Approve creates the tasks (on each job's task list) and saves the notes.
// Nothing is created from the AI's draft until Approve is pressed.
//
// Needs meetings.html's globals: me, staff, staffById, escapeHtml, modal,
// showToast, fmtShortDate, isoDate, addDays, todayStr and supabase-client.js.

const MAI_DB = 'te-meeting-recordings';
let mai = null; // state for the meeting currently shown

// ---------- tiny IndexedDB store so a crash or reload cannot lose a recording ----------
function maiDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MAI_DB, 1);
    req.onupgradeneeded = () => { const s = req.result.createObjectStore('chunks', { keyPath: 'k' }); s.createIndex('meetingId', 'meetingId'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function maiIdb(fn) {
  try { const db = await maiDb(); return await new Promise((resolve, reject) => { const tx = db.transaction('chunks', 'readwrite'); const r = fn(tx.objectStore('chunks')); tx.oncomplete = () => resolve(r && r.result); tx.onerror = () => reject(tx.error); }); }
  catch (err) { return null; } // private mode etc. - recording still works, just without the safety copy
}
const maiPutChunk = (meetingId, seq, blob, mime) => maiIdb(s => s.put({ k: `${meetingId}|${String(seq).padStart(6, '0')}`, meetingId, seq, blob, mime }));
async function maiGetChunks(meetingId) {
  const rows = await maiIdb(s => s.index('meetingId').getAll(meetingId));
  return (rows || []).sort((a, b) => a.seq - b.seq);
}
async function maiClearChunks(meetingId) {
  const rows = await maiGetChunks(meetingId);
  await maiIdb(s => { rows.forEach(r => s.delete(r.k)); });
}

// ---------- helpers ----------
const maiClock = (ms) => { const t = Math.floor((ms || 0) / 1000); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
const maiElapsed = (r) => (r.paused ? r.elapsed : r.elapsed + (Date.now() - r.resumedAt));
async function maiCall(name, body) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const res = await fetch('/.netlify/functions/' + name, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(body),
  });
  if (res.status === 202) return { ok: true };
  return res.json().catch(() => ({ ok: false, error: 'Unexpected reply from the server' }));
}
function ensureMaiStyles() {
  if (document.getElementById('mai-styles')) return;
  const st = document.createElement('style');
  st.id = 'mai-styles';
  st.textContent = `
    .mai-big { font-size:34px; font-weight:700; font-variant-numeric:tabular-nums; }
    .mai-dot { display:inline-block; width:12px; height:12px; border-radius:50%; background:#e5484d; margin-right:8px; animation: mai-pulse 1.2s infinite; }
    .mai-dot.paused { animation:none; background:var(--muted); }
    @keyframes mai-pulse { 50% { opacity:.25; } }
    .mai-level { height:8px; background:var(--surface-2); border-radius:4px; overflow:hidden; margin:10px 0; }
    .mai-level > div { height:100%; width:0; background:var(--accent); transition:width .1s; }
    .mai-spin { display:inline-block; width:14px; height:14px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation: mai-rot 1s linear infinite; vertical-align:-2px; margin-right:8px; }
    @keyframes mai-rot { to { transform:rotate(360deg); } }
    .mai-sec { margin-top:20px; }
    .mai-sec h3 { margin:0 0 8px; font-size:15px; }
    .mai-spk { display:grid; grid-template-columns: 70px 1fr 220px; gap:10px; align-items:start; padding:8px 0; border-top:1px solid var(--border); }
    .mai-line { font-size:12px; color:var(--muted); margin:0 0 2px; word-break:break-word; }
    .mai-group { margin-top:12px; }
    .mai-group-title { font-weight:700; font-size:14px; margin:0 0 6px; }
    .mai-act { border:1px solid var(--border); border-radius:10px; padding:10px; margin-bottom:8px; background:var(--surface); }
    .mai-act.excluded { opacity:.5; }
    .mai-act-top { display:flex; gap:8px; align-items:center; }
    .mai-act-top input[type=checkbox] { width:20px; height:20px; flex-shrink:0; }
    .mai-act-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; margin-top:8px; }
    .mai-act-grid label { margin:0; font-size:11px; color:var(--muted); }
    .mai-quote { font-size:12px; color:var(--muted); margin-top:8px; font-style:italic; word-break:break-word; }
    .mai-chip { display:inline-block; font-size:11px; font-weight:600; padding:1px 8px; border-radius:20px; border:1px solid var(--border); margin-left:6px; }
    .mai-chip.low { color:var(--red); border-color:var(--red); }
    .mai-chip.medium { color:#d9a23b; border-color:#d9a23b; }
    .mai-chip.high { color:#3fb97a; border-color:#3fb97a; }
    .mai-tr { max-height:420px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; padding:4px 10px; }
    .mai-u { display:grid; grid-template-columns:48px 130px 1fr; gap:8px; padding:5px 0; border-bottom:1px solid var(--border); font-size:13px; align-items:start; }
    .mai-u select { font-size:12px; padding:3px 4px; }
    .mai-u.hl { background:rgba(224,160,48,.18); }
    .mai-play { background:none; border:none; color:var(--accent); cursor:pointer; padding:0; font-size:12px; }
    @media (max-width: 700px) { .mai-spk { grid-template-columns:1fr; } .mai-act-grid { grid-template-columns:1fr; } .mai-u { grid-template-columns:44px 1fr; } .mai-u > :nth-child(3) { grid-column:1 / -1; } }
  `;
  document.head.appendChild(st);
}

// ---------- mount ----------
// opts: { getLinkedJobs(): [{id,label}], saveMeeting(): Promise<meeting>, refreshActions(), onNotesChanged(text) }
async function mountMeetingAi(el, meeting, opts) {
  ensureMaiStyles();
  if (mai && mai.poll) clearInterval(mai.poll);
  mai = { el, meeting, opts, rec: null, poll: null, analysisRequested: false, audioUrl: null, trOpen: false, trFilter: '', saveTimer: null, busy: false };
  const saved = await maiGetChunks(meeting.id);
  mai.leftover = saved.length ? saved : null;
  maiRender();
  if (opts.autoRecord) maiStartRecording();
}

function maiAlive() { return mai && document.body.contains(mai.el); }
function maiUnmount() {
  if (!mai) return;
  if (mai.poll) clearInterval(mai.poll);
  if (mai.rec) maiStopStreams();
  window.onbeforeunload = null;
  mai = null;
}
function maiIsRecording() { return !!(mai && mai.rec); }

function maiStatus() { return mai.meeting.ai_status || null; }

function maiRender() {
  if (!maiAlive()) return;
  const m = mai.meeting, el = mai.el, st = maiStatus();
  let html;
  if (mai.rec) html = maiRecordingHtml();
  else if (mai.busy) html = `<h2 style="margin-top:0;">Record and write up</h2><p><span class="mai-spin"></span>${escapeHtml(mai.busy)}</p>`;
  else if (st === 'transcribing') html = `<h2 style="margin-top:0;">Record and write up</h2><p><span class="mai-spin"></span>Transcribing the recording. A one hour meeting takes a few minutes. You can leave this page and come back, it keeps going.</p>`;
  else if (st === 'transcribed' || st === 'analyzing') html = `<h2 style="margin-top:0;">Record and write up</h2><p><span class="mai-spin"></span>${st === 'transcribed' ? 'Transcript ready. Starting the AI write-up...' : 'Reading the transcript and drafting the notes and tasks. This takes a minute or two. You can leave this page and come back.'}</p>`;
  else if (st === 'ready' && m.ai_draft) html = maiReviewHtml();
  else if (st === 'approved') html = maiApprovedHtml();
  else html = maiIdleHtml();
  el.innerHTML = `<div class="card" id="mai-card">${html}</div>`;
  maiBind();
  maiSyncPolling();
  if (st === 'transcribed' && !mai.analysisRequested && !mai.busy && !mai.rec) maiStartAnalysis();
}

function maiIdleHtml() {
  const m = mai.meeting;
  const jobs = mai.opts.getLinkedJobs();
  const err = m.ai_status === 'error' && m.ai_error ? `<div class="error-box" style="margin:0 0 12px;">${escapeHtml(m.ai_error)}</div>` : '';
  const hasAudio = !!m.audio_path, hasTranscript = Array.isArray(m.transcript) && m.transcript.length;
  return `
    <h2 style="margin-top:0;">Record and write up</h2>
    ${err}
    <p class="subtitle" style="margin-top:0;">Record the meeting here and AI will transcribe it, write up the notes and draft the follow-up tasks (who said they would do what, and by when). You check and fix everything before anything is saved. ${jobs.length ? `It will only look at the ${jobs.length} job${jobs.length === 1 ? '' : 's'} linked above.` : '<strong>Link the jobs you will talk about above first</strong> so it can match tasks to them.'}</p>
    ${mai.leftover ? `<div class="success-box" style="margin:0 0 12px;">There is an unsaved recording from earlier on this device (${mai.leftover.length} parts). <button type="button" id="mai-recover" style="margin-left:8px;">Process it</button> <button type="button" class="secondary" id="mai-discard">Discard</button></div>` : ''}
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <button type="button" id="mai-record">&#9679; Record meeting</button>
      <button type="button" class="secondary" id="mai-upload-btn">Upload a recording</button>
      <button type="button" class="secondary" id="mai-paste-btn">Paste a transcript</button>
      ${hasTranscript ? `<button type="button" class="secondary" id="mai-analyse">${m.ai_status === 'error' ? 'Try the AI write-up again' : 'Run the AI write-up'}</button>` : (hasAudio ? `<button type="button" class="secondary" id="mai-retranscribe">Transcribe the saved recording again</button>` : '')}
      <input type="file" id="mai-file" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.aac" style="display:none;" />
    </div>
    <p class="subtitle" style="margin:10px 0 0; font-size:12px;">Tell everyone it is being recorded. Keep this page open and the screen on while recording.</p>`;
}

function maiRecordingHtml() {
  const r = mai.rec;
  return `
    <h2 style="margin-top:0;">Recording</h2>
    <div class="mai-big"><span class="mai-dot ${r.paused ? 'paused' : ''}"></span><span id="mai-timer">${maiClock(maiElapsed(r))}</span></div>
    <div class="mai-level"><div id="mai-level"></div></div>
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <button type="button" id="mai-pause" class="secondary">${r.paused ? 'Resume' : 'Pause'}</button>
      <button type="button" id="mai-stop">Stop and write up</button>
    </div>
    <p class="subtitle" style="margin:10px 0 0; font-size:12px;">Keep this page open and the screen on. The recording is also backed up on this device as it goes.</p>`;
}

function maiApprovedHtml() {
  const m = mai.meeting, d = m.ai_draft || {};
  return `
    <h2 style="margin-top:0;">Record and write up</h2>
    <div class="success-box" style="margin:0 0 12px;">Approved${d.approved_at ? ' on ' + new Date(d.approved_at).toLocaleDateString('en-AU') : ''}. ${d.created != null ? `${d.created} task${d.created === 1 ? '' : 's'} created, they are listed under Actions below and on each job.` : ''} The notes are saved above.</div>
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <button type="button" class="secondary" id="mai-transcript-toggle">${mai.trOpen ? 'Hide' : 'Show'} the transcript</button>
      ${m.audio_path ? '<button type="button" class="secondary" id="mai-audio-btn">Play the recording</button>' : ''}
      <button type="button" class="secondary" id="mai-rerun">Run the AI write-up again</button>
    </div>
    <div id="mai-audio-wrap"></div>
    <div id="mai-transcript-wrap">${mai.trOpen ? maiTranscriptHtml() : ''}</div>`;
}

// ---------- polling ----------
function maiSyncPolling() {
  const st = maiStatus();
  const need = ['transcribing', 'analyzing', 'transcribed'].includes(st) && !mai.rec;
  if (need && !mai.poll) mai.poll = setInterval(maiPoll, 4000);
  if (!need && mai.poll) { clearInterval(mai.poll); mai.poll = null; }
}
async function maiReload() {
  const { data } = await supabaseClient.from('meetings').select('ai_status, ai_error, ai_draft, transcript, audio_path, audio_seconds, notes, attendee_ids, ai_updated_at').eq('id', mai.meeting.id).maybeSingle();
  if (data && mai) Object.assign(mai.meeting, data);
}
async function maiPoll() {
  if (!maiAlive()) { maiUnmount(); return; }
  const before = maiStatus();
  try {
    if (before === 'transcribing') {
      const r = await maiCall('transcribe-meeting', { meeting_id: mai.meeting.id, action: 'status' });
      if (r && r.ok === false && r.error) { mai.meeting.ai_status = 'error'; mai.meeting.ai_error = r.error; }
    }
    await maiReload();
  } catch (err) { return; } // transient - try again next tick
  if (!maiAlive()) return;
  // the AI write-up never picked up the job: let the person retry
  if (maiStatus() === 'transcribed' && mai.analysisRequested && Date.now() - (mai.analysisAt || 0) > 45000) {
    mai.meeting.ai_status = 'error'; mai.meeting.ai_error = 'The AI write-up did not start. Try again.';
    maiRender(); return;
  }
  // stuck analysing for a long time: let the person retry
  if (maiStatus() === 'analyzing' && mai.meeting.ai_updated_at && Date.now() - new Date(mai.meeting.ai_updated_at).getTime() > 12 * 60000) {
    mai.meeting.ai_status = 'error'; mai.meeting.ai_error = 'The AI write-up is taking too long. Try again.';
  }
  if (maiStatus() !== before) maiRender();
}
async function maiStartAnalysis() {
  mai.analysisRequested = true;
  mai.analysisAt = Date.now();
  mai.meeting.ai_status = 'analyzing';
  mai.meeting.ai_updated_at = new Date().toISOString();
  maiRender();
  const r = await maiCall('analyze-meeting-background', { meeting_id: mai.meeting.id });
  if (r && r.ok === false) { mai.meeting.ai_status = 'error'; mai.meeting.ai_error = r.error || 'Could not start the AI write-up'; maiRender(); }
}
async function maiStartTranscription() {
  mai.busy = 'Starting the transcription...'; maiRender();
  const r = await maiCall('transcribe-meeting', { meeting_id: mai.meeting.id, action: 'start' });
  mai.busy = false;
  if (!r.ok) {
    mai.meeting.ai_status = 'error'; mai.meeting.ai_error = r.error || 'Could not start the transcription';
    await supabaseClient.from('meetings').update({ ai_status: 'error', ai_error: mai.meeting.ai_error }).eq('id', mai.meeting.id);
  } else mai.meeting.ai_status = 'transcribing';
  maiRender();
}

// ---------- recording ----------
function maiPickMime() {
  const c = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return (window.MediaRecorder && c.find(t => MediaRecorder.isTypeSupported(t))) || '';
}
const maiExt = (mime) => (/mp4/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm');

async function maiStartRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) { alert('This browser cannot record audio. Try Chrome, Safari or Edge, or upload a recording instead.'); return; }
  try { await mai.opts.saveMeeting(); } catch (err) { alert(err.message); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (err) { alert('Could not use the microphone: ' + (err.message || err.name) + '. Allow microphone access for this site and try again.'); return; }
  const mime = maiPickMime();
  const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 });
  const rec = { recorder, stream, mime: recorder.mimeType || mime || 'audio/webm', chunks: [], seq: 0, paused: false, elapsed: 0, resumedAt: Date.now(), tick: null, ctx: null, wake: null };
  mai.rec = rec;
  const meetingId = mai.meeting.id;
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) { rec.chunks.push(e.data); maiPutChunk(meetingId, rec.seq++, e.data, rec.mime); } };
  recorder.onstop = () => maiFinishRecording(rec);
  recorder.start(5000);
  // level meter
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
    rec.ctx = ctx; rec.analyser = an;
  } catch (e) { /* meter is optional */ }
  try { if (navigator.wakeLock) rec.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
  window.onbeforeunload = () => 'A recording is in progress.';
  rec.tick = setInterval(() => {
    const t = document.getElementById('mai-timer'); if (t) t.textContent = maiClock(maiElapsed(rec));
    const lv = document.getElementById('mai-level');
    if (lv && rec.analyser) { const a = new Uint8Array(rec.analyser.fftSize); rec.analyser.getByteTimeDomainData(a); let peak = 0; a.forEach(v => { peak = Math.max(peak, Math.abs(v - 128)); }); lv.style.width = Math.min(100, peak * 1.6) + '%'; }
  }, 200);
  maiRender();
}
function maiStopStreams() {
  const rec = mai && mai.rec; if (!rec) return;
  clearInterval(rec.tick);
  try { rec.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { if (rec.ctx) rec.ctx.close(); } catch (e) {}
  try { if (rec.wake) rec.wake.release(); } catch (e) {}
}
function maiTogglePause() {
  const rec = mai.rec; if (!rec) return;
  if (rec.paused) { rec.recorder.resume(); rec.paused = false; rec.resumedAt = Date.now(); }
  else { rec.recorder.pause(); rec.elapsed += Date.now() - rec.resumedAt; rec.paused = true; }
  maiRender();
}
function maiStopRecording() {
  const rec = mai.rec; if (!rec) return;
  if (rec.elapsed + (rec.paused ? 0 : Date.now() - rec.resumedAt) < 3000 && !confirm('That is under 3 seconds. Stop anyway?')) return;
  if (rec.recorder.state !== 'inactive') rec.recorder.stop();
}
async function maiFinishRecording(rec) {
  maiStopStreams();
  window.onbeforeunload = null;
  const meetingId = mai ? mai.meeting.id : null;
  const blob = new Blob(rec.chunks, { type: rec.mime });
  if (mai) { mai.rec = null; }
  if (!mai || mai.meeting.id !== meetingId) return;
  await maiProcessAudio(blob, maiExt(rec.mime), rec.mime);
}
async function maiProcessAudio(blob, ext, mime) {
  const m = mai.meeting;
  mai.busy = `Uploading the recording (${(blob.size / 1048576).toFixed(1)} MB)...`; maiRender();
  const path = `${m.id}/${Date.now()}.${ext}`;
  const { error } = await supabaseClient.storage.from('meeting-audio').upload(path, blob, { contentType: mime || blob.type || 'audio/mpeg' });
  if (error) {
    mai.busy = false; maiRender();
    alert('The upload failed: ' + error.message + '\n\nYour recording is still saved on this device. Use "Process it" to try again.');
    mai.leftover = await maiGetChunks(m.id); maiRender();
    return;
  }
  if (m.audio_path) supabaseClient.storage.from('meeting-audio').remove([m.audio_path]).then(() => {}, () => {});
  await supabaseClient.from('meetings').update({ audio_path: path, transcript: null, ai_draft: null, ai_status: null, ai_error: null }).eq('id', m.id);
  Object.assign(m, { audio_path: path, transcript: null, ai_draft: null, ai_status: null, ai_error: null });
  await maiClearChunks(m.id); mai.leftover = null; mai.analysisRequested = false;
  await maiStartTranscription();
}
async function maiRecover() {
  const chunks = mai.leftover || [];
  if (!chunks.length) return;
  const mime = chunks[0].mime || 'audio/webm';
  await maiProcessAudio(new Blob(chunks.map(c => c.blob), { type: mime }), maiExt(mime), mime);
}

// ---------- pasted transcript ----------
function maiParseTranscript(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const t = line.trim(); if (!t) return;
    const mm = t.match(/^(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*)?([A-Za-z][A-Za-z .'-]{0,38}):\s+(.+)$/);
    if (mm) out.push({ speaker: mm[1].trim(), text: mm[2].trim() });
    else if (out.length) out[out.length - 1].text += ' ' + t;
    else out.push({ speaker: 'A', text: t });
  });
  return out.map((u, i) => ({ i, speaker: u.speaker, text: u.text, start: 0, end: 0 }));
}
function maiOpenPaste() {
  const o = modal(`
    <h2 style="margin-top:0;">Paste a transcript</h2>
    <p class="subtitle" style="margin-top:0;">From another tool, or typed up. Put each person's name before what they said, like <em>Cooper: I will chase the board.</em> Lines without a name are treated as one speaker.</p>
    <textarea id="mai-paste-text" style="min-height:220px;"></textarea>
    <div style="margin-top:12px;"><button type="button" id="mai-paste-go">Use this transcript</button> <button type="button" class="secondary" id="mai-paste-cancel">Cancel</button></div>
    <div id="mai-paste-msg"></div>`);
  o.querySelector('#mai-paste-cancel').addEventListener('click', () => o.remove());
  o.querySelector('#mai-paste-go').addEventListener('click', async () => {
    const tr = maiParseTranscript(o.querySelector('#mai-paste-text').value);
    if (!tr.length) { o.querySelector('#mai-paste-msg').innerHTML = '<div class="error-box">Paste some text first.</div>'; return; }
    try { await mai.opts.saveMeeting(); } catch (err) { o.querySelector('#mai-paste-msg').innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`; return; }
    const { error } = await supabaseClient.from('meetings').update({ transcript: tr, ai_status: 'transcribed', ai_error: null, ai_draft: null }).eq('id', mai.meeting.id);
    if (error) { o.querySelector('#mai-paste-msg').innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`; return; }
    Object.assign(mai.meeting, { transcript: tr, ai_status: 'transcribed', ai_error: null, ai_draft: null });
    mai.analysisRequested = false;
    o.remove(); maiRender();
  });
}

// ---------- review ----------
function maiDraft() { return mai.meeting.ai_draft; }
function maiSaveDraftSoon() {
  const ind = document.getElementById('mai-saved');
  if (ind) ind.textContent = 'Saving...';
  clearTimeout(mai.saveTimer);
  mai.saveTimer = setTimeout(async () => {
    const { error } = await supabaseClient.from('meetings').update({ ai_draft: maiDraft() }).eq('id', mai.meeting.id);
    const i2 = document.getElementById('mai-saved'); if (i2) i2.textContent = error ? 'Could not save your changes: ' + error.message : 'Draft saved';
  }, 700);
}
function maiSpeakerName(label) {
  const s = (maiDraft().speakers || {})[label] || {};
  if (s.staff_id && staffById[s.staff_id]) return staffById[s.staff_id].full_name;
  return s.name || `Speaker ${label}`;
}
const maiLineSpeaker = (u) => (maiDraft().utterance_speakers || {})[u.i] || u.speaker;
const maiHasAudio = () => !!mai.meeting.audio_path;
function maiLabels() { return [...new Set((mai.meeting.transcript || []).map(u => u.speaker))]; }

function maiReviewHtml() {
  const d = maiDraft(), tr = mai.meeting.transcript || [];
  const labels = maiLabels();
  const jobs = mai.opts.getLinkedJobs();
  const sample = (label) => tr.filter(u => maiLineSpeaker(u) === label).slice(0, 2);
  const staffOpts = (sel) => `<option value="">Not set</option>` + staff.map(s => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${escapeHtml(s.full_name || 'Unnamed')}</option>`).join('');
  const playBtn = (ms) => maiHasAudio() && ms != null ? `<button type="button" class="mai-play" data-play="${ms}" title="Play from here">&#9654; ${maiClock(ms)}</button>` : '';

  const speakersHtml = labels.map(l => {
    const s = d.speakers[l] || {};
    return `<div class="mai-spk">
      <div><strong>${escapeHtml(l.length > 3 ? l : 'Speaker ' + l)}</strong><span class="mai-chip ${s.confidence || 'low'}">${s.confidence || 'low'}</span></div>
      <div>${sample(l).map(u => `<p class="mai-line">${playBtn(u.start)} "${escapeHtml(u.text.length > 120 ? u.text.slice(0, 120) + '...' : u.text)}"</p>`).join('') || '<p class="mai-line">(no lines)</p>'}${s.reason ? `<p class="mai-line">AI: ${escapeHtml(s.reason)}</p>` : ''}</div>
      <div><select data-spk="${escapeHtml(l)}">${staffOpts(s.staff_id)}</select>
        ${!s.staff_id ? `<input data-spkname="${escapeHtml(l)}" placeholder="Not staff? type their name" value="${escapeHtml(s.name || '')}" style="margin-top:6px;" />` : ''}</div>
    </div>`;
  }).join('');

  const groupIds = [...jobs.map(j => j.id), null];
  const actionCard = (a) => {
    const uttr = a.utterance != null ? tr.find(u => u.i === a.utterance) : null;
    return `<div class="mai-act ${a.include ? '' : 'excluded'}" data-act="${a.id}">
      <div class="mai-act-top">
        <input type="checkbox" data-f="include" ${a.include ? 'checked' : ''} title="Include this task" />
        <input data-f="description" value="${escapeHtml(a.description)}" placeholder="What needs doing" />
        <span class="mai-chip ${a.confidence || 'high'}" title="How sure the AI was">${a.confidence || 'high'}</span>
        <button type="button" class="secondary" data-del="${a.id}" style="padding:4px 10px; font-size:12px;" title="Remove">&times;</button>
      </div>
      <div class="mai-act-grid">
        <div><label>Job</label><select data-f="project_id"><option value="">Not a specific job</option>${jobs.map(j => `<option value="${j.id}" ${j.id === a.project_id ? 'selected' : ''}>${escapeHtml(j.label)}</option>`).join('')}</select></div>
        <div><label>Who is doing it</label><select data-f="assignee_id">${staffOpts(a.assignee_id)}</select></div>
        <div><label>Due date${a.due_text ? ` (they said "${escapeHtml(a.due_text)}")` : ''}</label><input type="date" data-f="due_date" value="${a.due_date || ''}" /></div>
      </div>
      ${a.quote ? `<div class="mai-quote">${uttr ? playBtn(uttr.start) + ' ' : ''}"${escapeHtml(a.quote)}"${uttr ? ' - ' + escapeHtml(maiSpeakerName(maiLineSpeaker(uttr))) : ''}</div>` : ''}
    </div>`;
  };
  const groupsHtml = groupIds.map(gid => {
    const rows = d.actions.filter(a => (a.project_id || null) === gid);
    const job = gid ? jobs.find(j => j.id === gid) : null;
    if (!rows.length && !gid && jobs.length) return '';
    return `<div class="mai-group"><p class="mai-group-title">${job ? escapeHtml(job.label) : 'Not tied to a job'} (${rows.length})</p>
      ${rows.map(actionCard).join('') || '<p class="subtitle" style="margin:0 0 6px;">No tasks.</p>'}
      <button type="button" class="secondary" data-add="${gid || ''}" style="font-size:12px; padding:5px 10px;">+ Add a task${job ? ' for this job' : ''}</button></div>`;
  }).join('');

  const included = d.actions.filter(a => a.include && a.description.trim()).length;
  return `
    <h2 style="margin-top:0;">Check the AI draft</h2>
    <p class="subtitle" style="margin-top:0;">Nothing has been saved yet. Fix anything the AI got wrong below, then approve. Your changes save as you go (<span id="mai-saved">Draft saved</span>).</p>
    ${maiHasAudio() ? '<audio id="mai-audio" controls preload="none" style="width:100%; margin-bottom:6px;"></audio>' : ''}

    <div class="mai-sec"><h3>1. Who is who</h3>
      <p class="subtitle" style="margin:0 0 6px;">Speakers are detected automatically and can be wrong. Pick the right person for each voice. If one person was split into two voices, choose the same person for both.</p>
      ${speakersHtml}
    </div>

    <div class="mai-sec"><h3>2. Meeting notes</h3>
      <textarea id="mai-notes" style="min-height:200px;">${escapeHtml(d.notes_text || '')}</textarea>
    </div>

    <div class="mai-sec"><h3>3. Tasks</h3>
      <p class="subtitle" style="margin:0 0 6px;">Each ticked task goes onto its job's task list for the person shown. Untick or remove anything that is not a real task.</p>
      ${groupsHtml}
    </div>

    <div class="mai-sec"><h3>Transcript</h3>
      <p class="subtitle" style="margin:0 0 6px;">If a line is attributed to the wrong person, change it here and any task it came from follows.</p>
      <button type="button" class="secondary" id="mai-transcript-toggle">${mai.trOpen ? 'Hide' : 'Show'} the transcript (${tr.length} lines)</button>
      <div id="mai-transcript-wrap">${mai.trOpen ? maiTranscriptHtml() : ''}</div>
    </div>

    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:22px; align-items:center;">
      <button type="button" id="mai-approve">Approve and create ${included} task${included === 1 ? '' : 's'}</button>
      <button type="button" class="secondary" id="mai-rerun">Run the AI write-up again</button>
    </div>
    <div id="mai-msg"></div>`;
}

function maiTranscriptHtml() {
  const tr = mai.meeting.transcript || [], d = maiDraft();
  const labels = maiLabels();
  const q = (mai.trFilter || '').toLowerCase();
  const lines = tr.filter(u => !q || u.text.toLowerCase().includes(q));
  const canEdit = d && mai.meeting.ai_status === 'ready';
  return `<input id="mai-tr-filter" placeholder="Search the transcript..." value="${escapeHtml(mai.trFilter || '')}" style="margin:8px 0;" />
    <div class="mai-tr">${lines.map(u => {
      const sp = d ? maiLineSpeaker(u) : u.speaker;
      return `<div class="mai-u" data-u="${u.i}">
        <div>${maiHasAudio() && u.end ? `<button type="button" class="mai-play" data-play="${u.start}">&#9654; ${maiClock(u.start)}</button>` : ''}</div>
        <div>${canEdit ? `<select data-uspk="${u.i}">${labels.map(l => `<option value="${escapeHtml(l)}" ${l === sp ? 'selected' : ''}>${escapeHtml(maiSpeakerName(l))}</option>`).join('')}</select>` : escapeHtml(d ? maiSpeakerName(sp) : sp)}</div>
        <div>${escapeHtml(u.text)}</div>
      </div>`;
    }).join('') || '<p class="subtitle">No lines match.</p>'}</div>`;
}

async function maiPlayAt(ms) {
  const a = document.getElementById('mai-audio');
  if (!a) { await maiShowAudio(); return maiPlayAt(ms); }
  if (!a.src) {
    const { data, error } = await supabaseClient.storage.from('meeting-audio').createSignedUrl(mai.meeting.audio_path, 3 * 3600);
    if (error) { alert('Could not load the recording: ' + error.message); return; }
    a.src = data.signedUrl;
    await new Promise(r => { a.addEventListener('loadedmetadata', r, { once: true }); a.addEventListener('error', r, { once: true }); a.load(); setTimeout(r, 4000); });
  }
  try { a.currentTime = (ms || 0) / 1000; await a.play(); } catch (e) { /* browser may refuse seeking on some recordings - it still plays */ }
}
async function maiShowAudio() {
  const wrap = document.getElementById('mai-audio-wrap'); if (!wrap || document.getElementById('mai-audio')) return;
  wrap.innerHTML = '<audio id="mai-audio" controls preload="none" style="width:100%; margin-top:10px;"></audio>';
}

// ---------- events ----------
function maiBind() {
  const el = mai.el;
  const on = (id, fn) => { const x = el.querySelector('#' + id); if (x) x.addEventListener('click', fn); };
  on('mai-record', maiStartRecording);
  on('mai-pause', maiTogglePause);
  on('mai-stop', maiStopRecording);
  on('mai-upload-btn', () => el.querySelector('#mai-file').click());
  on('mai-paste-btn', maiOpenPaste);
  on('mai-recover', maiRecover);
  on('mai-discard', async () => { if (!confirm('Delete that unsaved recording from this device?')) return; await maiClearChunks(mai.meeting.id); mai.leftover = null; maiRender(); });
  on('mai-analyse', () => { mai.analysisRequested = false; maiStartAnalysis(); });
  on('mai-retranscribe', maiStartTranscription);
  on('mai-audio-btn', maiShowAudio);
  on('mai-rerun', () => { if (confirm('Run the AI write-up again? This replaces the current draft (including any changes you made to it). Tasks already created are not touched.')) maiStartAnalysis(); });
  on('mai-approve', maiApprove);
  on('mai-transcript-toggle', () => { mai.trOpen = !mai.trOpen; maiRender(); });
  const file = el.querySelector('#mai-file');
  if (file) file.addEventListener('change', async () => {
    const f = file.files[0]; if (!f) return;
    try { await mai.opts.saveMeeting(); } catch (err) { alert(err.message); return; }
    const ext = (f.name.split('.').pop() || 'm4a').toLowerCase();
    await maiProcessAudio(f, ext, f.type || 'audio/mpeg');
  });

  const card = el.querySelector('#mai-card');
  if (!card) return;
  card.addEventListener('click', (e) => {
    const p = e.target.closest('[data-play]'); if (p) { maiPlayAt(Number(p.dataset.play)); return; }
    const del = e.target.closest('[data-del]');
    if (del) { const d = maiDraft(); d.actions = d.actions.filter(a => a.id !== del.dataset.del); maiSaveDraftSoon(); maiRerenderReview(); return; }
    const add = e.target.closest('[data-add]');
    if (add) {
      const d = maiDraft();
      d.actions.push({ id: 'm' + Date.now().toString(36), include: true, description: '', project_id: add.dataset.add || null, assignee_speaker: null, assignee_id: null, due_date: null, due_text: null, utterance: null, quote: '', confidence: 'high' });
      maiSaveDraftSoon(); maiRerenderReview();
      const inputs = card.querySelectorAll('[data-act] input[data-f="description"]'); if (inputs.length) inputs[inputs.length - 1].focus();
    }
  });
  card.addEventListener('input', (e) => {
    const t = e.target, d = maiDraft(); if (!d) return;
    if (t.id === 'mai-notes') { d.notes_text = t.value; maiSaveDraftSoon(); }
    else if (t.id === 'mai-tr-filter') { mai.trFilter = t.value; const w = card.querySelector('#mai-transcript-wrap'); const pos = t.selectionStart; w.innerHTML = maiTranscriptHtml(); const n = w.querySelector('#mai-tr-filter'); n.focus(); n.setSelectionRange(pos, pos); }
    else if (t.dataset.spkname) { d.speakers[t.dataset.spkname].name = t.value.trim() || null; maiSaveDraftSoon(); }
    else if (t.dataset.f === 'description') { const a = d.actions.find(x => x.id === t.closest('[data-act]').dataset.act); if (a) { a.description = t.value; maiSaveDraftSoon(); } }
  });
  card.addEventListener('change', (e) => {
    const t = e.target, d = maiDraft(); if (!d) return;
    if (t.dataset.spk) {
      const label = t.dataset.spk;
      d.speakers[label].staff_id = t.value || null;
      if (t.value) d.speakers[label].name = staffById[t.value] ? staffById[t.value].full_name : null;
      // tasks that follow this voice follow the change
      d.actions.forEach(a => { if (a.assignee_speaker === label) a.assignee_id = t.value || null; });
      maiSaveDraftSoon(); maiRerenderReview();
    } else if (t.dataset.uspk != null && t.dataset.uspk !== '') {
      const i = Number(t.dataset.uspk), u = (mai.meeting.transcript || []).find(x => x.i === i); if (!u) return;
      const old = maiLineSpeaker(u);
      d.utterance_speakers = d.utterance_speakers || {};
      if (t.value === u.speaker) delete d.utterance_speakers[i]; else d.utterance_speakers[i] = t.value;
      // a task backed by this line moves to whoever really said it
      d.actions.forEach(a => {
        if (a.utterance === i && a.assignee_speaker === old && !a.assignee_manual) {
          a.assignee_speaker = t.value;
          const sid = (d.speakers[t.value] || {}).staff_id; a.assignee_id = sid || null;
        }
      });
      maiSaveDraftSoon(); maiRerenderReview();
    } else if (t.dataset.f) {
      const a = d.actions.find(x => x.id === t.closest('[data-act]').dataset.act); if (!a) return;
      if (t.dataset.f === 'include') a.include = t.checked;
      else if (t.dataset.f === 'project_id') a.project_id = t.value || null;
      else if (t.dataset.f === 'assignee_id') { a.assignee_id = t.value || null; a.assignee_speaker = null; a.assignee_manual = true; }
      else if (t.dataset.f === 'due_date') a.due_date = t.value || null;
      maiSaveDraftSoon(); maiRerenderReview();
    }
  });
}
// re-render the review without losing scroll position
function maiRerenderReview() {
  const y = window.scrollY;
  maiRender();
  window.scrollTo(0, y);
}

// ---------- approve ----------
async function maiApprove() {
  const d = maiDraft(), m = mai.meeting;
  const chosen = d.actions.filter(a => a.include && a.description.trim());
  const unassigned = chosen.filter(a => !a.assignee_id).length;
  const msg = document.getElementById('mai-msg');
  if (!chosen.length && !confirm('There are no tasks ticked. Save just the notes?')) return;
  if (unassigned && !confirm(`${unassigned} task${unassigned === 1 ? ' has' : 's have'} nobody assigned, so ${unassigned === 1 ? 'it' : 'they'} will go on the list for anyone to pick up. Continue?`)) return;
  const btn = document.getElementById('mai-approve'); btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const dateLabel = new Date(m.meeting_date + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    const rows = chosen.map(a => ({
      project_id: a.project_id || null, description: a.description.trim(), assigned_to_user_id: a.assignee_id || null, due_date: a.due_date || null,
      meeting_id: m.id, task_type: 'prejob', created_by: me,
      notes: `From the meeting "${m.title}" (${dateLabel})${a.quote ? ': "' + a.quote + '"' : ''}`,
    }));
    if (rows.length) { const { error } = await supabaseClient.from('job_tasks').insert(rows); if (error) throw error; }
    const byJob = {}; chosen.forEach(a => { if (a.project_id) byJob[a.project_id] = (byJob[a.project_id] || 0) + 1; });
    for (const [pid, n] of Object.entries(byJob)) await logActivity('project', pid, 'task_added', `${n} task${n === 1 ? '' : 's'} added from the meeting "${m.title}"`);
    const notes = [m.notes && m.notes.trim(), (d.notes_text || '').trim()].filter(Boolean).join('\n\n');
    const attendees = [...new Set([...(m.attendee_ids || []), ...Object.values(d.speakers).map(s => s.staff_id).filter(Boolean)])];
    const finalDraft = { ...d, approved_at: new Date().toISOString(), approved_by: me, created: rows.length };
    const { error: upErr } = await supabaseClient.from('meetings').update({ notes, attendee_ids: attendees, ai_status: 'approved', ai_draft: finalDraft }).eq('id', m.id);
    if (upErr) throw upErr;
    Object.assign(m, { notes, attendee_ids: attendees, ai_status: 'approved', ai_draft: finalDraft });
    if (mai.opts.onApproved) mai.opts.onApproved(m);
    maiRender();
    showToast(`Saved. ${rows.length} task${rows.length === 1 ? '' : 's'} created.`);
  } catch (err) {
    btn.disabled = false; btn.textContent = 'Approve';
    if (msg) msg.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
  }
}
