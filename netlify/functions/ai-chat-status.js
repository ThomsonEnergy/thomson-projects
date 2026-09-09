const { createClient } = require('@supabase/supabase-js');

// Polled by the "Ask AI" chat widget after ai-chat.js hands back a job id,
// until status is 'done' or 'error'. Built with the caller's own token so
// RLS (ai_chat_jobs restricts each row to its own user_id) does the access
// control - nobody can poll someone else's chat job by guessing an id.

const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppYWtwa2xuemtiYmpqbnFna216Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTg2OTIsImV4cCI6MjEwMjY3NDY5Mn0.xuEorSGdx9rI_ySM6V4MOxoQLOTD1OCWdrSXKMKnFAE';
const SERVER_CLIENT_OPTS = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Not logged in.' }) };

    const { job_id } = JSON.parse(event.body || '{}');
    if (!job_id) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'job_id required' }) };

    const userClient = createClient(process.env.SUPABASE_URL, SUPABASE_ANON_KEY, {
      ...SERVER_CLIENT_OPTS,
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data, error } = await userClient.from('ai_chat_jobs').select('status, answer, error').eq('id', job_id).maybeSingle();
    if (error) throw error;
    if (!data) return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Job not found.' }) };

    return { statusCode: 200, body: JSON.stringify({ ok: true, ...data }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
