const { getAdminClient } = require('./_shared/require-admin');

// POST /.netlify/functions/submit-review   { t: token, rating: 1-5, comment?: string }
//   or { t: token, google_clicked: true }  (they pressed "Post it on Google" afterwards)
//
// Public (no login). The review can be saved once per link, and can be changed afterwards by
// the same link. Tells whoever sent the request (a bell notification, and so a phone push).

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const body = JSON.parse(event.body || '{}');
    const token = String(body.t || '');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return json(404, { ok: false, error: 'This link is not valid.' });
    const admin = getAdminClient();
    const { data: row } = await admin.from('review_requests').select('id, project_id, client_name, created_by, submitted_at').eq('token', token).maybeSingle();
    if (!row) return json(404, { ok: false, error: 'This link is not valid.' });

    if (body.google_clicked) {
      await admin.from('review_requests').update({ google_clicked_at: new Date().toISOString() }).eq('id', row.id);
      return json(200, { ok: true });
    }

    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return json(400, { ok: false, error: 'Please choose a star rating from 1 to 5.' });
    const comment = String(body.comment || '').trim().slice(0, 3000) || null;
    const first = !row.submitted_at;
    const { error } = await admin.from('review_requests').update({ rating, comment, submitted_at: new Date().toISOString() }).eq('id', row.id);
    if (error) throw error;

    if (row.created_by) {
      const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
      await admin.rpc('create_notification', {
        p_user: row.created_by, p_kind: 'review',
        p_title: `${row.client_name || 'A client'} left a ${rating}-star review`, p_body: `${stars}${comment ? ' ' + comment : ''}`,
        p_link: row.project_id ? `/project.html?id=${row.project_id}&tab=emails` : '/home.html', p_actor: null,
        p_dedupe: `review:${row.id}:${rating}:${first ? 'new' : Date.now()}`,
      });
    }
    return json(200, { ok: true });
  } catch (err) {
    console.error('submit-review failed:', err.message);
    return json(500, { ok: false, error: 'Something went wrong. Please try again in a moment.' });
  }
};
