const webpush = require('web-push');
const { getIntegrationKey } = require('./get-integration-key');

// Phone / browser push for the notifications table. Used by the scheduled
// send-notifications function (every minute) and by notify-test (instant).
//
// VAPID keys live in the api_keys table (vapid_public_key / vapid_private_key)
// like every other integration key, so nothing secret is in the repo. The
// public key is also baked into js/notifications.js, which is fine: it is
// public by design and only identifies this server to the browser's push
// service.

let configured = false;
async function configure() {
  if (configured) return;
  const pub = await getIntegrationKey('vapid_public_key');
  const priv = await getIntegrationKey('vapid_private_key');
  webpush.setVapidDetails('mailto:jasper@thomsonenergy.com.au', pub, priv);
  configured = true;
}

// Sends every notification that has not been pushed yet (or just `onlyIds`)
// to each of its owner's subscribed devices, then marks it pushed. A device
// the push service says is gone (404 / 410) is forgotten.
// `send` is injectable for tests.
async function deliverPending(supabaseAdmin, { onlyIds = null, send = null } = {}) {
  const sendFn = send || (async (sub, payload) => { await configure(); return webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 24, urgency: 'high' }); });

  let q = supabaseAdmin.from('notifications').select('id, user_id, kind, title, body, link').is('pushed_at', null);
  q = onlyIds ? q.in('id', onlyIds) : q.gt('created_at', new Date(Date.now() - 2 * 86400000).toISOString()).order('created_at').limit(300);
  const { data: rows, error } = await q;
  if (error) throw error;
  if (!rows || !rows.length) return { notifications: 0, sent: 0, failed: 0, removed: 0 };

  const userIds = [...new Set(rows.map(r => r.user_id))];
  const { data: subs } = await supabaseAdmin.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth').in('user_id', userIds);
  const unread = {};
  await Promise.all(userIds.filter(u => (subs || []).some(s => s.user_id === u)).map(async (u) => {
    const { count } = await supabaseAdmin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', u).is('read_at', null);
    unread[u] = count || 0;
  }));

  let sent = 0, failed = 0; const dead = new Set();
  for (const n of rows) {
    for (const s of (subs || []).filter(x => x.user_id === n.user_id && !dead.has(x.id))) {
      const payload = JSON.stringify({ id: n.id, title: n.title, body: n.body || '', url: n.link || '/home.html', tag: n.id, count: unread[n.user_id] || 0 });
      try {
        await sendFn({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        sent++;
      } catch (err) {
        failed++;
        if (err && (err.statusCode === 404 || err.statusCode === 410)) dead.add(s.id);
        else console.error('push failed:', err && (err.statusCode || err.message));
      }
    }
  }
  if (dead.size) await supabaseAdmin.from('push_subscriptions').delete().in('id', [...dead]);
  const okUsers = new Set((subs || []).filter(s => !dead.has(s.id)).map(s => s.user_id));
  if (sent) {
    const nowIso = new Date().toISOString();
    const sentUsers = [...okUsers];
    await supabaseAdmin.from('push_subscriptions').update({ last_success_at: nowIso }).in('user_id', sentUsers);
  }
  // Everything looked at is marked, so a person who subscribes later is not
  // flooded with old items, and nothing is retried forever.
  await supabaseAdmin.from('notifications').update({ pushed_at: new Date().toISOString() }).in('id', rows.map(r => r.id));
  return { notifications: rows.length, sent, failed, removed: dead.size };
}

module.exports = { deliverPending };
