// Server-to-server calls between this site's own functions (a sync starting a background
// worker, the PDF warmer, the chat sweep, the invoice PDF refresh after a payment) carry the
// header x-internal-secret with the value of INTERNAL_FUNCTION_SECRET (docs/ENV_VARS.md).
//
//   requireInternal(event)   true when the request carries the secret. Until the variable is set
//                            on the site it answers true and logs an error, so no worker stops
//                            before the key exists.
//   internalHeaders()        the header a caller adds to its fetch() to a background function.

const crypto = require('crypto');

function requireInternal(event) {
  const secret = process.env.INTERNAL_FUNCTION_SECRET || '';
  if (!secret) {
    console.error('INTERNAL_FUNCTION_SECRET is not set: calls between functions are not being checked');
    return true;
  }
  const headers = (event && event.headers) || {};
  const given = String(headers['x-internal-secret'] || headers['X-Internal-Secret'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function internalHeaders() {
  return { 'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '' };
}

module.exports = { requireInternal, internalHeaders };
