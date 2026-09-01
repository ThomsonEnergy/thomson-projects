// POST /.netlify/functions/add-agent-comment
// Body: { reportId, body, agentKey }
// Not a staff-authenticated endpoint - there's no logged-in user during a
// scheduled Claude Code check, so this is gated by a shared secret
// (CLAUDE_AGENT_KEY, set in Netlify env vars) instead, same pattern as
// GITHUB_TOKEN/DEV_MODE_PASSWORD elsewhere in this app. Lets a scheduled
// check leave a question on a bug/update report ("which button exactly?")
// for staff to answer in the app, without giving it a real user session.

const { getAdminClient } = require('./_shared/require-admin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const expectedKey = process.env.CLAUDE_AGENT_KEY;
  if (!expectedKey) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'CLAUDE_AGENT_KEY is not set in Netlify environment variables yet.' }) };
  }

  try {
    const { reportId, body, agentKey } = JSON.parse(event.body || '{}');
    if (agentKey !== expectedKey) {
      return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
    }
    if (!reportId || !body || !body.trim()) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'reportId and body are required' }) };
    }

    const supabaseAdmin = getAdminClient();
    const { error } = await supabaseAdmin.from('bug_report_comments').insert({
      report_id: reportId,
      author_type: 'claude',
      body: body.trim(),
    });
    if (error) throw error;

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('add-agent-comment error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
