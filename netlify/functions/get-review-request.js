const { getAdminClient } = require('./_shared/require-admin');

// GET /.netlify/functions/get-review-request?t=<token>
//
// Public (no login): what review.html calls. The unguessable token in the emailed link is
// the only key. Returns just enough to show the page: the client's first name, the company
// name and logo, the Google review link, and whether they have already answered.

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  const token = String((event.queryStringParameters || {}).t || '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return json(404, { ok: false, error: 'This link is not valid.' });
  try {
    const admin = getAdminClient();
    const { data: row, error } = await admin.from('review_requests').select('id, client_name, rating, comment, submitted_at').eq('token', token).maybeSingle();
    if (error) throw error;
    if (!row) return json(404, { ok: false, error: 'This link is not valid.' });
    const { data: company } = await admin.from('company_settings').select('company_name, logo_url, google_review_url').eq('id', 1).maybeSingle();
    return json(200, {
      ok: true,
      first_name: String(row.client_name || '').trim().split(/\s+/)[0] || '',
      company_name: (company && company.company_name) || 'Thomson Energy',
      google_url: (company && /^https?:\/\//i.test(company.google_review_url || '')) ? company.google_review_url : null,
      submitted: !!row.submitted_at, rating: row.rating || null, comment: row.comment || '',
    });
  } catch (err) {
    console.error('get-review-request failed:', err.message);
    return json(500, { ok: false, error: 'Something went wrong. Please try again in a moment.' });
  }
};
