// Scheduled every 4 minutes (see netlify.toml): pings the PDF function so it stays loaded and the
// Chromium it needs is already unpacked. A PDF asked for after a quiet spell otherwise spends the
// first several seconds waking the function up and unpacking the browser. Netlify does not let a
// scheduled function be called over HTTP, so this small function calls the PDF function.

const fetch = require('node-fetch');
const { selfBaseUrl } = require('./_shared/site-url');

exports.handler = async () => {
  try {
    const res = await fetch(`${selfBaseUrl()}/.netlify/functions/generate-client-document-pdf`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc_type: 'warm' }),
    });
    return { statusCode: res.ok ? 200 : 502, body: res.ok ? 'warm' : `PDF function answered ${res.status}` };
  } catch (err) {
    console.error('warm-pdf failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
