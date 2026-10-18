require('./_shared/polyfill-websocket');
const { createClient } = require('@supabase/supabase-js');
const { getAdminClient, getAuthCheckClient } = require('./_shared/require-admin');
const { processPending, answer } = require('./_shared/chat-ai');

// Background (up to 15 minutes). Started by chat-after-send.js with the
// sender's login and their new message ids, or by chat-ai-sweep.js with
// { sweep: true } and no login.
//  - Always: works through messages Sparky has not looked at yet (job tags,
//    voice transcripts). See _shared/chat-ai.js.
//  - With a login: answers any of those messages that @mention Sparky, using
//    the sender's own access for every lookup.

const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppYWtwa2xuemtiYmpqbnFna216Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTg2OTIsImV4cCI6MjEwMjY3NDY5Mn0.xuEorSGdx9rI_ySM6V4MOxoQLOTD1OCWdrSXKMKnFAE';
const SERVER_CLIENT_OPTS = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };

exports.handler = async (event) => {
  const admin = getAdminClient();
  try {
    const { token, message_ids: ids } = JSON.parse(event.body || '{}');

    let user = null, userClient = null;
    if (token) {
      const { data } = await getAuthCheckClient().auth.getUser(token);
      user = data && data.user;
      if (user) userClient = createClient(process.env.SUPABASE_URL, SUPABASE_ANON_KEY, { ...SERVER_CLIENT_OPTS, global: { headers: { Authorization: `Bearer ${token}` } } });
    }

    // Questions first so a person is not kept waiting behind other people's
    // tagging; answer() waits for a voice question's transcript itself, so
    // the tagging (which makes it) runs alongside.
    const tagging = processPending(admin, { limit: 25 }).catch((err) => console.error('chat tagging failed:', err.message));
    if (user && Array.isArray(ids)) {
      for (const id of ids.slice(0, 20)) {
        try {
          await answer(admin, userClient, user.id, id);
        } catch (err) {
          console.error('Sparky chat answer failed:', id, err.message);
        }
      }
    }
    await tagging;
    await processPending(admin, { limit: 25 });
  } catch (err) {
    console.error('chat-ai-background failed:', err);
  }
  return { statusCode: 202, body: '' };
};
