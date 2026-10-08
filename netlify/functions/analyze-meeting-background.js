const fetch = require('node-fetch');
const { requireActiveUser } = require('./_shared/require-active-user');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { buildPrompt, buildDraft } = require('./_shared/meeting-ai');

// POST { meeting_id } - background function (up to 15 minutes), so the page
// does not wait on it: it sets meetings.ai_status to 'analyzing', and to
// 'ready' (with the draft in meetings.ai_draft) or 'error' when it is done.
//
// Reads the meeting's transcript plus ONLY the jobs linked to the meeting
// (meetings.project_ids) and the staff list, and asks Claude to draft the
// meeting notes and the follow-up actions. Nothing is created from the draft
// here - a person checks and approves it on the Meetings page first.

exports.handler = async (event) => {
  const auth = await requireActiveUser(event);
  if (!auth) return { statusCode: 202, body: '' };
  const { supabaseAdmin } = auth;
  let meetingId;
  try {
    meetingId = JSON.parse(event.body || '{}').meeting_id;
    if (!meetingId) return { statusCode: 202, body: '' };
    await supabaseAdmin.from('meetings').update({ ai_status: 'analyzing', ai_error: null, ai_updated_at: new Date().toISOString() }).eq('id', meetingId);

    const { data: meeting, error } = await supabaseAdmin.from('meetings').select('*').eq('id', meetingId).single();
    if (error || !meeting) throw new Error('Meeting not found');
    const transcript = Array.isArray(meeting.transcript) ? meeting.transcript : [];
    if (!transcript.length) throw new Error('There is no transcript to work from yet');

    const projectIds = (meeting.project_ids || []).slice(0, 12);
    let jobs = [];
    if (projectIds.length) {
      const { data: rows } = await supabaseAdmin.from('projects')
        .select('id, name, job_number, quote_number, client_name, client_address, pipeline_stage, notes, installer_summary, sow_text')
        .in('id', projectIds);
      jobs = projectIds.map(id => (rows || []).find(r => r.id === id)).filter(Boolean);
      const { data: tasks } = await supabaseAdmin.from('job_tasks').select('project_id, description').in('project_id', projectIds).eq('completed', false).is('parent_task_id', null);
      jobs.forEach(j => { j.open_tasks = (tasks || []).filter(t => t.project_id === j.id).slice(0, 15).map(t => t.description); });
    }
    const { data: staff } = await supabaseAdmin.from('profiles').select('id, full_name').eq('active', true).order('full_name');

    const prompt = buildPrompt({ meeting, jobs, staff: staff || [], transcript });
    const apiKey = await getIntegrationKey('anthropic');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic API error: ${res.status} ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const raw = (data.content || []).map(b => b.text || '').join('');
    const draft = buildDraft(raw, { jobs, staff: staff || [], transcript });

    await supabaseAdmin.from('meetings').update({ ai_draft: draft, ai_status: 'ready', ai_error: null, ai_updated_at: new Date().toISOString() }).eq('id', meetingId);
  } catch (err) {
    console.error('analyze-meeting failed:', err);
    if (meetingId) await supabaseAdmin.from('meetings').update({ ai_status: 'error', ai_error: err.message, ai_updated_at: new Date().toISOString() }).eq('id', meetingId).then(() => {}, () => {});
  }
  return { statusCode: 202, body: '' };
};
