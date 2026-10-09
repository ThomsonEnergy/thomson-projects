const { requireActiveUser } = require('./_shared/require-active-user');
const { runSync } = require('./_shared/gmail-sync');

// POST - the "Sync now" button (Settings and Inbox). Same work as the scheduled
// sync-gmail.js, but callable over HTTP and limited to signed-in staff. It stops
// after a few seconds if there is a lot to pull in and reports how much is left,
// so pressing it again carries on.

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(403, { ok: false, error: 'Not signed in.' });
  try {
    const result = await runSync({ budgetMs: 7000 });
    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error('sync-gmail-now failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
