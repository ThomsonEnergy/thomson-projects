const webpush = require('web-push');
const { getIntegrationKey } = require('./get-integration-key');
const { createApnsSender } = require('./apns');

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
// Browsers get web push; the TEgo iPhone app (platform 'ios') gets Apple push.
// Only bell rows, chat DMs and @mentions are sent to the phone: emails, channel
// chatter and thread replies stay on the Messages icon (they are still marked
// pushed so they are never retried). The app badge count is the bell count.
// `send` and `sendApns` are injectable for tests.
const goesToPhone = (n) => n.channel === 'bell' || n.kind === 'chat_dm' || n.kind === 'chat_mention';
async function deliverPending(supabaseAdmin, { onlyIds = null, send = null, sendApns = null } = {}) {
  // A setup failure (VAPID keys or the APNs key unreadable) is a config problem, not a reason to drop
  // notifications: that channel is skipped for the rest of this run, its notifications stay unmarked for
  // the next minute, and the other channel still goes. Each setup is tried once per run and logged once.
  let webDown = null, apnsDown = null;
  const sendFn = send || (async (sub, payload) => {
    if (webDown) throw webDown;
    try { await configure(); } catch (err) { webDown = Object.assign(new Error('web push not configured: ' + err.message), { setup: true }); throw webDown; }
    return webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 24, urgency: 'high' });
  });
  let apns = null;
  const apnsSend = sendApns || (async (token, n) => {
    if (apnsDown) throw apnsDown;
    if (!apns) {
      try { apns = await createApnsSender(); } catch (err) { apnsDown = Object.assign(new Error('APNs not configured: ' + err.message), { setup: true }); throw apnsDown; }
    }
    return apns.send(token, n);
  });

  let q = supabaseAdmin.from('notifications').select('id, user_id, kind, channel, title, body, link').is('pushed_at', null);
  q = onlyIds ? q.in('id', onlyIds) : q.gt('created_at', new Date(Date.now() - 2 * 86400000).toISOString()).order('created_at').limit(300);
  const { data: rows, error } = await q;
  if (error) throw error;
  if (!rows || !rows.length) return { notifications: 0, sent: 0, failed: 0, removed: 0 };

  const toSend = rows.filter(goesToPhone);
  const userIds = [...new Set(toSend.map(r => r.user_id))];
  // A failed lookup stops here before anything is marked pushed, so the rows are tried again next minute
  // instead of being dropped (F33 in docs/BUG_REVIEW_2026-10-23.md); unreadable push keys are handled per
  // send above, so one bad channel never stops the other.
  const { data: subs, error: subErr } = await supabaseAdmin.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth, platform').in('user_id', userIds);
  if (subErr) throw subErr;
  const unread = {};
  await Promise.all(userIds.filter(u => (subs || []).some(s => s.user_id === u)).map(async (u) => {
    const { count } = await supabaseAdmin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', u).eq('channel', 'bell').is('read_at', null);
    unread[u] = count || 0;
  }));

  let sent = 0, failed = 0; const dead = new Set();
  // notifications that reached no device because the push service or network failed (a 5xx, a 429, no
  // answer): left unmarked so the next run tries them again (the two day window above bounds the retries)
  const retry = new Set();
  for (const n of toSend) {
    let reached = false, transient = false;
    for (const s of (subs || []).filter(x => x.user_id === n.user_id && !dead.has(x.id))) {
      const msg = { id: n.id, title: n.title, body: n.body || '', url: n.link || '/home.html', tag: n.id, count: unread[n.user_id] || 0 };
      try {
        if (s.platform === 'ios') await apnsSend(s.endpoint, msg);
        else await sendFn({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg));
        sent++;
        reached = true;
      } catch (err) {
        failed++;
        const code = err && err.statusCode;
        if (code === 404 || code === 410) dead.add(s.id);
        else {
          if (!code || code === 429 || code >= 500) transient = true;
          if (!(err && err.setup && err.logged)) console.error('push failed:', code || (err && err.message));
          if (err && err.setup) err.logged = true;
        }
      }
    }
    if (transient && !reached) retry.add(n.id);
  }
  if (apns) apns.close();
  if (dead.size) await supabaseAdmin.from('push_subscriptions').delete().in('id', [...dead]);
  const okUsers = new Set((subs || []).filter(s => !dead.has(s.id)).map(s => s.user_id));
  if (sent) {
    const nowIso = new Date().toISOString();
    const sentUsers = [...okUsers];
    await supabaseAdmin.from('push_subscriptions').update({ last_success_at: nowIso }).in('user_id', sentUsers);
  }
  // Everything looked at is marked (except the transient failures above), so a person who subscribes
  // later is not flooded with old items, and nothing is retried forever.
  const markIds = rows.map(r => r.id).filter(id => !retry.has(id));
  if (markIds.length) {
    const { error: markErr } = await supabaseAdmin.from('notifications').update({ pushed_at: new Date().toISOString() }).in('id', markIds);
    if (markErr) throw markErr;
  }
  return { notifications: rows.length, sent, failed, removed: dead.size, retry: retry.size };
}

module.exports = { deliverPending };
