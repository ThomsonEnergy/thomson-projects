// Starts finalize-quote-documents-background.js (it replies 202 straight away and carries on in the
// background). The request is awaited, but only until it has been accepted: a function can be frozen the
// moment it returns, so a request that was merely fired and forgotten can be dropped before it is sent.
// Never throws: the client who just signed must not see an error because a PDF could not be started.

const fetch = require('node-fetch');
const { selfBaseUrl } = require('./site-url');

async function startFinalizeDocuments(payload) {
  try {
    const res = await fetch(`${selfBaseUrl()}/.netlify/functions/finalize-quote-documents-background`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeout: 8000,
    });
    if (!res.ok && res.status !== 202) console.error('finalize documents did not start:', res.status);
  } catch (err) {
    console.error('finalize documents did not start:', err.message);
  }
}

module.exports = { startFinalizeDocuments };
