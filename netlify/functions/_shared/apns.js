const http2 = require('http2');
const crypto = require('crypto');
const { getIntegrationKey } = require('./get-integration-key');

// Apple push (APNs) for the TEgo iPhone app. Web push (push.js) cannot reach
// the app, so push.js sends to iPhone devices through this instead.
//
// Keys live in the api_keys table like every other integration key:
//   apns_key_id       the 10 character Key ID of the .p8 key (Apple Developer > Keys)
//   apns_team_id      the 10 character Team ID (Apple Developer > Membership)
//   apns_private_key  the whole .p8 file text, including the BEGIN/END lines
// One .p8 key works for every app on the team and never expires.
//
// TestFlight and App Store builds use Apple's production server. A build run
// straight from Xcode uses the sandbox one, so a token production rejects as
// BadDeviceToken is tried once on sandbox before it is treated as dead.

const BUNDLE_ID = 'au.com.thomsonenergy.app';
const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };

let creds = null;
let jwt = null;
let jwtAt = 0;

async function loadCreds() {
  if (creds) return creds;
  const [keyId, teamId, privateKey] = await Promise.all(['apns_key_id', 'apns_team_id', 'apns_private_key'].map(getIntegrationKey));
  creds = { keyId: keyId.trim(), teamId: teamId.trim(), privateKey: privateKey.replace(/\\n/g, '\n').trim() };
  return creds;
}

// Apple wants a fresh ES256 token at least every hour, and no more than one
// new one every 20 minutes.
function authToken({ keyId, teamId, privateKey }) {
  const now = Math.floor(Date.now() / 1000);
  if (jwt && now - jwtAt < 40 * 60) return jwt;
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64({ alg: 'ES256', kid: keyId })}.${b64({ iss: teamId, iat: now })}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  jwt = `${unsigned}.${sig.toString('base64url')}`;
  jwtAt = now;
  return jwt;
}

function post(session, token, deviceToken, payload, tag) {
  return new Promise((resolve, reject) => {
    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${token}`,
      'apns-topic': BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 24 * 3600),
    };
    if (tag) headers['apns-collapse-id'] = String(tag).slice(0, 64);
    const req = session.request(headers);
    let status = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let reason = '';
      try { reason = body ? JSON.parse(body).reason || '' : ''; } catch (e) { reason = body; }
      resolve({ status, reason });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.end(JSON.stringify(payload));
  });
}

// Returns a sender for one delivery run: send(deviceToken, { title, body, url, tag, count }).
// Throws an error with statusCode 410 when the device is gone, so push.js
// forgets it the same way it forgets a dead web push subscription.
async function createApnsSender() {
  const c = await loadCreds();
  const sessions = {};
  const sessionFor = (env) => {
    if (!sessions[env] || sessions[env].closed || sessions[env].destroyed) {
      sessions[env] = http2.connect(HOSTS[env]);
      sessions[env].on('error', (err) => console.error(`apns ${env} connection error:`, err.message));
    }
    return sessions[env];
  };

  async function send(deviceToken, n) {
    const payload = {
      aps: { alert: { title: n.title, body: n.body || '' }, sound: 'default', badge: n.count || 0 },
      url: n.url || '/home.html',
    };
    const token = authToken(c);
    let res = await post(sessionFor('production'), token, deviceToken, payload, n.tag);
    if (res.status === 400 && res.reason === 'BadDeviceToken') res = await post(sessionFor('sandbox'), token, deviceToken, payload, n.tag);
    if (res.status === 200) return;
    const err = new Error(`APNs ${res.status} ${res.reason}`);
    err.statusCode = (res.status === 410 || res.reason === 'BadDeviceToken' || res.reason === 'Unregistered') ? 410 : res.status;
    throw err;
  }

  function close() { Object.values(sessions).forEach((s) => { try { s.close(); } catch (e) { /* already closed */ } }); }

  return { send, close };
}

module.exports = { createApnsSender, BUNDLE_ID };
