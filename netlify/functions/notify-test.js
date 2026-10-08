const { requireActiveUser } = require('./_shared/require-active-user');
const { deliverPending } = require('./_shared/push');

// POST - sends the signed-in person a test notification right now (the
// "Send a test" button in the notifications panel), so they can see phone
// notifications are working without waiting for something real to happen.

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(403, { ok: false, error: 'Not signed in' });
  const { supabaseAdmin, user } = auth;
  try {
    const { count: devices } = await supabaseAdmin.from('push_subscriptions').select('id', { count: 'exact', head: true }).eq('user_id', user.id);
    const dedupe = 'test:' + Date.now();
    const { error } = await supabaseAdmin.rpc('create_notification', {
      p_user: user.id, p_kind: 'test', p_title: 'Test notification', p_body: 'If you can read this on your lock screen, phone notifications are working.',
      p_link: '/home.html', p_actor: null, p_dedupe: dedupe,
    });
    if (error) throw error;
    const { data: row } = await supabaseAdmin.from('notifications').select('id').eq('user_id', user.id).eq('dedupe_key', dedupe).maybeSingle();
    let result = { sent: 0, failed: 0 };
    if (row && devices) result = await deliverPending(supabaseAdmin, { onlyIds: [row.id] });
    return json(200, { ok: true, devices: devices || 0, sent: result.sent, failed: result.failed });
  } catch (err) {
    console.error('notify-test failed:', err);
    return json(500, { ok: false, error: err.message });
  }
};
