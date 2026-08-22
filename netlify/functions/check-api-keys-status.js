// GET /.netlify/functions/check-api-keys-status
// Admin-only. Returns which keys have a value saved, without ever
// returning the values themselves - the point is that the raw secret
// never has to reach the browser just to show "this one's set."

const { requireAdmin } = require('./_shared/require-admin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireAdmin(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
  }
  const { supabaseAdmin } = auth;

  try {
    const { data, error } = await supabaseAdmin.from('api_keys').select('key_name, key_value');
    if (error) throw error;

    const status = {};
    (data || []).forEach(row => {
      status[row.key_name] = !!(row.key_value && row.key_value.trim());
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, status }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
