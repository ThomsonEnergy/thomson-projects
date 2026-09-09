const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

// Starts an "Ask AI" chat turn and returns immediately with a job id - the
// actual tool-calling loop (often several chained Claude calls: search the
// knowledge base, dig into a specific document, maybe check live data too)
// routinely runs longer than a normal function's ~10s synchronous budget,
// so the real work happens in ai-chat-background.js instead. The browser
// polls ai-chat-status.js with the returned job id for the result.

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

    const userClient = createClient(process.env.SUPABASE_URL, SUPABASE_ANON_KEY, {
      ...SERVER_CLIENT_OPTS,
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData || !userData.user) {
      return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Session expired - refresh the page and log in again.' }) };
    }

    const { messages } = JSON.parse(event.body || '{}');
    if (!Array.isArray(messages) || !messages.length) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'No message.' }) };
    }

    const { data: job, error: insErr } = await userClient
      .from('ai_chat_jobs')
      .insert({ user_id: userData.user.id, messages, status: 'pending' })
      .select('id')
      .single();
    if (insErr) throw insErr;

    // Fire-and-forget - a background function replies 202 immediately
    // regardless of what it returns, so there's nothing useful to await
    // here beyond the request actually going out.
    fetch(`${process.env.URL || ''}/.netlify/functions/ai-chat-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: job.id, token, messages }),
    }).catch(() => {});

    return { statusCode: 200, body: JSON.stringify({ ok: true, job_id: job.id }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
