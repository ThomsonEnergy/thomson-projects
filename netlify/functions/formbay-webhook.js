// POST /.netlify/functions/formbay-webhook
// Configured in Formbay > Settings > Webhooks, subscribed to job.created, job.updated, job.deleted
// and doc.updated. Formbay sends a webhook.test ping before it saves the webhook and only saves it
// if this returns 2xx.
//
// Formbay has no signature scheme, so the webhook is set up with a custom header:
// X-Webhook-Secret, with the same value saved in Settings > API Keys > Formbay Webhook Secret.
// Anything without the right header is refused.
//
// Formbay does not document the payload, so for now every event is stored as it arrived in
// formbay_webhook_events (migration 146). Processing comes once we have seen real payloads.

const crypto = require('crypto');
const { getAdminClient } = require('./_shared/require-admin');
const { getIntegrationKey } = require('./_shared/get-integration-key');

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Best guess at the event name and job id from an undocumented payload.
function pick(obj, keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), obj);
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let secret;
  try { secret = String(await getIntegrationKey('formbay_webhook_secret')).trim(); } catch (err) {
    console.error('Formbay webhook: no secret saved in Settings > API Keys > Formbay Webhook Secret.');
    return { statusCode: 401, body: '' };
  }
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const given = headers['x-webhook-secret'] || (event.queryStringParameters && event.queryStringParameters.secret) || '';
  if (!given || !sameSecret(given.trim(), secret)) {
    console.error('Formbay webhook: missing or wrong X-Webhook-Secret header.');
    return { statusCode: 401, body: '' };
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  let payload = null;
  try { payload = JSON.parse(rawBody); } catch (e) { /* kept as raw_body */ }

  const eventType = payload ? pick(payload, ['event', 'event_type', 'eventType', 'type', 'name']) : null;
  const jobId = payload ? pick(payload, ['formid', 'form_id', 'job_id', 'jobId', 'id', 'data.formid', 'data.form_id', 'data.job_id', 'data.id', 'job.formid', 'job.id']) : null;

  const { error } = await getAdminClient().from('formbay_webhook_events').insert({
    event_type: eventType,
    formbay_job_id: jobId,
    payload,
    raw_body: payload ? null : rawBody.slice(0, 100000),
  });
  if (error) {
    console.error('Formbay webhook: could not store event', error.message);
    return { statusCode: 500, body: '' };
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
