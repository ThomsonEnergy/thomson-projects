require('./_shared/polyfill-websocket');
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

    // A background function replies 202 straight away regardless of how
    // long its work takes, so awaiting this is quick - and it has to be
    // awaited: a serverless function can be frozen the moment it returns,
    // so an un-awaited request can be dropped before it ever leaves,
    // leaving the job "pending" forever (this was why the chat just
    // timed out). If the worker can't be started, say so on the job now
    // instead of leaving the browser polling until it gives up.
    let startError = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const bgRes = await fetch(`${process.env.URL || 'https://thomsonprojects.netlify.app'}/.netlify/functions/ai-chat-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: job.id, token, messages }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!bgRes.ok) startError = `The AI worker didn't start (HTTP ${bgRes.status}).`;
    } catch (err) {
      startError = `The AI worker couldn't be reached: ${err.message}`;
    }
    if (startError) {
      await userClient.from('ai_chat_jobs').update({ status: 'error', error: startError }).eq('id', job.id);
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: startError }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, job_id: job.id }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
