const fetch = require('node-fetch');
const { selfBaseUrl } = require('./_shared/site-url');

// Every 2 minutes (netlify.toml): makes sure no chat message is missed by
// Sparky's job tagging and voice transcripts, for example when a phone sent
// it and lost signal before chat-after-send ran. The work itself is in
// chat-ai-background.js (scheduled functions only get 30 seconds).
exports.handler = async () => {
  try {
    const res = await fetch(`${selfBaseUrl()}/.netlify/functions/chat-ai-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sweep: true }),
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, started: res.status }) };
  } catch (err) {
    console.error('chat-ai-sweep failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
