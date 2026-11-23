// POST /.netlify/functions/push-emailed-invoice-background   Body: { invoiceId }
// An invoice goes to Xero by itself once it is emailed to the client (owner, 20 Nov 2026). send-gmail.js
// starts this after the email has gone (_shared/push-invoice-to-xero.js startPushWhenEmailed), as a
// background function so the person sending never waits on Xero. Only our own functions may call it
// (the internal secret, _shared/require-internal.js). Does nothing when the invoice is already in Xero;
// what Xero refuses is written to the invoice's history, where Push to Xero still works.

const { getAdminClient } = require('./_shared/require-admin');
const { requireInternal } = require('./_shared/require-internal');
const { pushWhenEmailed } = require('./_shared/push-invoice-to-xero');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!requireInternal(event)) return { statusCode: 403, body: 'Forbidden' };
  let invoiceId = null;
  try { ({ invoiceId } = JSON.parse(event.body || '{}')); } catch (err) { /* not JSON: refused below */ }
  if (!UUID.test(invoiceId || '')) return { statusCode: 400, body: 'invoiceId is required' };
  const result = await pushWhenEmailed(getAdminClient(), invoiceId);
  return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
};
