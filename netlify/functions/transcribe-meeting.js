const fetch = require('node-fetch');
const { requireActiveUser } = require('./_shared/require-active-user');
const { getIntegrationKey } = require('./_shared/get-integration-key');

// POST { meeting_id, action: 'start' | 'status' }
//
// Turns a meeting's uploaded recording (meetings.audio_path, in the private
// meeting-audio bucket) into a speaker-by-speaker transcript using
// AssemblyAI. Claude can't listen to audio, so this is the one step that
// needs a separate speech-to-text key (Settings > API Keys > AssemblyAI).
//
// 'start' hands AssemblyAI a short-lived signed link to the audio (so the
// file itself never passes through this function) and records the job id.
// 'status' is polled by the page: it asks AssemblyAI how it's going and,
// once finished, stores the transcript on the meeting. Safe to call
// repeatedly, and from any browser - whoever polls next moves it along.

const ASSEMBLY = 'https://api.assemblyai.com/v2';

function json(statusCode, body) { return { statusCode, body: JSON.stringify(body) }; }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(403, { ok: false, error: 'Not signed in' });
  const { supabaseAdmin } = auth;

  try {
    const { meeting_id: meetingId, action } = JSON.parse(event.body || '{}');
    if (!meetingId) return json(400, { ok: false, error: 'meeting_id is required' });
    const { data: meeting, error } = await supabaseAdmin.from('meetings').select('id, audio_path, ai_status, transcript_id').eq('id', meetingId).single();
    if (error || !meeting) return json(404, { ok: false, error: 'Meeting not found' });

    let apiKey;
    try { apiKey = await getIntegrationKey('assemblyai'); }
    catch { return json(200, { ok: false, needs_key: true, error: 'No AssemblyAI key saved yet - an admin can add one in Settings > API Keys.' }); }

    if (action === 'start') {
      if (!meeting.audio_path) return json(400, { ok: false, error: 'This meeting has no recording yet' });
      const { data: signed, error: signErr } = await supabaseAdmin.storage.from('meeting-audio').createSignedUrl(meeting.audio_path, 6 * 3600);
      if (signErr || !signed) throw new Error(signErr ? signErr.message : 'Could not link to the recording');
      const res = await fetch(`${ASSEMBLY}/transcript`, {
        method: 'POST',
        headers: { authorization: apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ audio_url: signed.signedUrl, speaker_labels: true, language_code: 'en_au', punctuate: true, format_text: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.id) throw new Error(`AssemblyAI would not start the transcript: ${data.error || res.status}`);
      await supabaseAdmin.from('meetings').update({ transcript_id: data.id, ai_status: 'transcribing', ai_error: null, ai_updated_at: new Date().toISOString() }).eq('id', meetingId);
      return json(200, { ok: true, status: 'transcribing' });
    }

    // status
    if (meeting.ai_status !== 'transcribing' || !meeting.transcript_id) return json(200, { ok: true, status: meeting.ai_status });
    const res = await fetch(`${ASSEMBLY}/transcript/${meeting.transcript_id}`, { headers: { authorization: apiKey } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`AssemblyAI status check failed: ${data.error || res.status}`);

    if (data.status === 'error') {
      await supabaseAdmin.from('meetings').update({ ai_status: 'error', ai_error: `Transcription failed: ${data.error || 'unknown error'}`, ai_updated_at: new Date().toISOString() }).eq('id', meetingId);
      return json(200, { ok: true, status: 'error', error: data.error });
    }
    if (data.status !== 'completed') return json(200, { ok: true, status: 'transcribing' });

    // Prefer speaker-attributed utterances; a recording with only one voice
    // (or no detectable speakers) may only come back as plain text.
    let utterances = (data.utterances || []).map((u, i) => ({ i, speaker: u.speaker || 'A', text: u.text, start: u.start, end: u.end }));
    if (!utterances.length && data.text) utterances = [{ i: 0, speaker: 'A', text: data.text, start: 0, end: Math.round((data.audio_duration || 0) * 1000) }];
    await supabaseAdmin.from('meetings').update({
      transcript: utterances, ai_status: 'transcribed', ai_error: null,
      audio_seconds: data.audio_duration ? Math.round(data.audio_duration) : null,
      ai_updated_at: new Date().toISOString(),
    }).eq('id', meetingId);
    return json(200, { ok: true, status: 'transcribed' });
  } catch (err) {
    console.error('transcribe-meeting failed:', err);
    return json(500, { ok: false, error: err.message });
  }
};
