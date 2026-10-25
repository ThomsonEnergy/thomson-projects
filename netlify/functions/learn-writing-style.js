// POST /.netlify/functions/learn-writing-style
// Any active staff member, for their own My inbox; Admin, Finance or Sales for sales@.
//   { mailbox: 'mine' | 'sales', action: 'learn' }              asks Postie to learn the
//        writing style from the replies sent from that mailbox (the mailbox worker does
//        the reading, Settings polls mailboxes.writing_style_learned_at).
//   { mailbox: 'mine' | 'sales', action: 'save', text: '...' }  saves a hand edited guide.
//   { mailbox: 'mine' | 'sales', action: 'source', value: 'company' | 'own' }  which voice
//        that mailbox drafts in (the company voice, or its own learned style).
//   { action: 'info' }   the company voice (address, learned date); Admin also gets the list
//        of mailboxes with a learned style to choose from.
//   { action: 'company_voice', mailbox_id }   Admin only: sets the company voice (or none).
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

  if (body.action === 'info') {
    const { data: cs } = await admin.from('company_settings').select('writing_style_mailbox_id').eq('id', 1).maybeSingle();
    let company = null;
    if (cs?.writing_style_mailbox_id) {
      const { data: mb } = await admin.from('mailboxes').select('id, address, writing_style, writing_style_learned_at').eq('id', cs.writing_style_mailbox_id).maybeSingle();
      if (mb) company = { id: mb.id, address: mb.address, learned: !!String(mb.writing_style || '').trim(), learned_at: mb.writing_style_learned_at };
    }
    let options = null;
    if (auth.role === 'admin') {
      const { data: rows } = await admin.from('mailboxes').select('id, address').not('writing_style', 'is', null).order('address');
      options = rows || [];
    }
    return json(200, { ok: true, company, options, isAdmin: auth.role === 'admin' });
  }
  if (body.action === 'company_voice') {
    if (auth.role !== 'admin') return json(403, { ok: false, error: 'Only an admin can set the company voice.' });
    const id = body.mailbox_id || null;
    if (id) {
      const { data: mb } = await admin.from('mailboxes').select('id').eq('id', id).maybeSingle();
      if (!mb) return json(404, { ok: false, error: 'That mailbox does not exist.' });
    }
    const { error } = await admin.from('company_settings').update({ writing_style_mailbox_id: id }).eq('id', 1);
    if (error) return json(500, { ok: false, error: error.message });
    return json(200, { ok: true });
  }

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
    if (body.action === 'source') {
      const value = body.value === 'own' ? 'own' : 'company';
      const { error } = await admin.from('mailboxes').update({ writing_style_source: value }).eq('id', mailbox.id);
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
