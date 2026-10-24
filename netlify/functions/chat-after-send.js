require('./_shared/polyfill-websocket');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const { requireActiveUser } = require('./_shared/require-active-user');
const { deliverPending } = require('./_shared/push');
const { selfBaseUrl } = require('./_shared/site-url');
const { internalHeaders } = require('./_shared/require-internal');

// POST { message_ids: [...] }, called by chat.html right after it sends
// (including messages that sat in the offline queue).
//  1. Pushes the notifications for those messages straight away, instead of
//     waiting up to a minute for send-notifications.
//  2. Starts chat-ai-background, which tags them to jobs, turns voice into
//     text and answers @Sparky (each only for people with AI consent).

const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppYWtwa2xuemtiYmpqbnFna216Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTg2OTIsImV4cCI6MjEwMjY3NDY5Mn0.xuEorSGdx9rI_ySM6V4MOxoQLOTD1OCWdrSXKMKnFAE';
const SERVER_CLIENT_OPTS = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(401, { ok: false, error: 'Not logged in' });
  const { supabaseAdmin, user } = auth;
  const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');

  try {
    const { message_ids: ids } = JSON.parse(event.body || '{}');
    if (!Array.isArray(ids) || !ids.length) return json(400, { ok: false, error: 'message_ids is required' });

    // Only the sender's own messages, checked with their own login (RLS).
    const userClient = createClient(process.env.SUPABASE_URL, SUPABASE_ANON_KEY, { ...SERVER_CLIENT_OPTS, global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: mine } = await userClient.from('chat_messages').select('id').in('id', ids.slice(0, 50)).eq('author_id', user.id);
    const mineIds = (mine || []).map((m) => m.id);
    if (!mineIds.length) return json(200, { ok: true, pushed: 0 });

    let pushed = null;
    try {
      const { data: notes } = await supabaseAdmin.from('notifications').select('id').in('dedupe_key', mineIds.map((id) => 'chat:' + id)).is('pushed_at', null);
      if (notes && notes.length) pushed = await deliverPending(supabaseAdmin, { onlyIds: notes.map((n) => n.id) });
    } catch (err) {
      console.error('chat push failed (send-notifications will retry):', err.message);
    }

    // Awaited: a function can be frozen as soon as it returns. A background
    // function answers 202 straight away.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      await fetch(`${selfBaseUrl()}/.netlify/functions/chat-ai-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...internalHeaders() },
        body: JSON.stringify({ token, message_ids: mineIds }),
        signal: controller.signal,
      });
      clearTimeout(timer);
    } catch (err) {
      console.error('chat-ai-background did not start (the sweep will pick it up):', err.message);
    }

    return json(200, { ok: true, pushed });
  } catch (err) {
    console.error('chat-after-send failed:', err);
    return json(500, { ok: false, error: err.message });
  }
};
