// POST /.netlify/functions/learn-writing-style
// Any active staff member, for their own My inbox; Admin, Finance or Sales for sales@.
//   { mailbox: 'mine' | 'sales', action: 'learn' }              asks Postie to learn the
//        writing style from the replies sent from that mailbox (the mailbox worker does
//        the reading, Settings polls mailboxes.writing_style_learned_at).
//   { mailbox: 'mine' | 'sales', action: 'save', text: '...' }  saves a hand edited guide.
// The guide itself is read through the mailboxes table (RLS: sales@ plus your own).

const { requireActiveUser } = require('./_shared/require-active-user');
const { startMailboxWork } = require('./_shared/gmail-sync');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const PRICING = ['admin', 'finance', 'sales'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(403, { ok: false, error: 'Not signed in.' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Bad request.' }); }
  const admin = auth.supabaseAdmin;

  let q = admin.from('mailboxes').select('id, address, kind, writing_style_requested_at').not('connected_at', 'is', null);
  if (body.mailbox === 'sales') {
    if (!PRICING.includes(auth.role)) return json(403, { ok: false, error: 'Only Admin, Finance or Sales can change the sales@ writing style.' });
    q = q.eq('kind', 'shared');
  } else if (body.mailbox === 'mine') {
    q = q.eq('kind', 'personal').eq('owner_id', auth.user.id);
  } else return json(400, { ok: false, error: 'Which mailbox?' });
  const { data: mailbox } = await q.maybeSingle();
  if (!mailbox) return json(404, { ok: false, error: 'That mailbox is not connected.' });

  try {
    if (body.action === 'save') {
      const text = String(body.text || '').replace(/—/g, ',').trim().slice(0, 6000);
      const { error } = await admin.from('mailboxes').update({ writing_style: text || null, writing_style_edited_at: text ? new Date().toISOString() : null }).eq('id', mailbox.id);
      if (error) throw error;
      return json(200, { ok: true });
    }
    if (body.action === 'learn') {
      if (mailbox.writing_style_requested_at && Date.now() - new Date(mailbox.writing_style_requested_at).getTime() < 15 * 60000) {
        return json(200, { ok: true, already: true });
      }
      const { error } = await admin.from('mailboxes').update({ writing_style_requested_at: new Date().toISOString(), writing_style_error: null }).eq('id', mailbox.id);
      if (error) throw error;
      await startMailboxWork();
      return json(200, { ok: true });
    }
    return json(400, { ok: false, error: 'Unknown action.' });
  } catch (err) {
    console.error('learn-writing-style failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
