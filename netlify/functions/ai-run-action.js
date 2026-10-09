require('./_shared/polyfill-websocket');
const { createClient } = require('@supabase/supabase-js');
const { execute, ACTION_TOOL_NAMES } = require('./_shared/ai-actions');

// POST { type, params } - carries out ONE change the AI assistant proposed, after
// the person pressed Confirm in the chat. Runs as that person (their own token,
// anon key), so the database's own rules decide what is allowed, exactly as if
// they had made the change in the app: anyone can create tasks, only admin,
// finance and sales can change the Schedule. The change is checked again here
// before it is made.

const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppYWtwa2xuemtiYmpqbnFna216Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTg2OTIsImV4cCI6MjEwMjY3NDY5Mn0.xuEorSGdx9rI_ySM6V4MOxoQLOTD1OCWdrSXKMKnFAE';
const SERVER_CLIENT_OPTS = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return json(401, { ok: false, error: 'Not logged in.' });
    const client = createClient(process.env.SUPABASE_URL, SUPABASE_ANON_KEY, { ...SERVER_CLIENT_OPTS, global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: userData, error: userErr } = await client.auth.getUser(token);
    if (userErr || !userData || !userData.user) return json(401, { ok: false, error: 'Session expired - refresh the page and log in again.' });

    const { type, params } = JSON.parse(event.body || '{}');
    if (!ACTION_TOOL_NAMES.includes(type) || !params || typeof params !== 'object') return json(400, { ok: false, error: 'That is not an action I can do.' });

    const result = await execute(client, userData.user.id, type, params);
    return json(result.ok ? 200 : 422, result);
  } catch (err) {
    console.error('ai-run-action failed:', err);
    return json(500, { ok: false, error: err.message });
  }
};
