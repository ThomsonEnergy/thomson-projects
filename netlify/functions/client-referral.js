// POST /.netlify/functions/client-referral   (Admin, Finance and Sales; backlog item 74b, step 3a)
// The lead reward and referral link on the Clients page:
//   { action: 'set_kind', clientId, kind: 'off' | 'credit' }  a credit off our work, never a payout
//        (owner, 20 Nov 2026); turning it on from off emails
//        the client their link by itself (so nobody has to remember to send it)
//   { action: 'send', clientId }        email the link again
//   { action: 'regenerate', clientId }  a new link; the old one stops working at once
// Writes clients.lead_reward_kind and referral_token, and activity_log.

const crypto = require('crypto');
const { requirePricingRole } = require('./_shared/require-pricing-role');
const { sendReferralLink } = require('./_shared/portal-mail');
const { publicBaseUrl } = require('./_shared/site-url');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['off', 'credit'];
const HOW = { credit: 'a credit off your next invoice with us', off: 'our thanks' };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin: admin, user } = auth;
  try {
    const body = JSON.parse(event.body || '{}');
    if (!UUID.test(body.clientId || '')) return json(400, { ok: false, error: 'Which client?' });
    const { data: client } = await admin.from('clients').select('id, name, email, lead_reward_kind, referral_token').eq('id', body.clientId).maybeSingle();
    if (!client) return json(404, { ok: false, error: 'Client not found.' });
    const log = (action, description) => admin.from('activity_log').insert({ entity_type: 'client', entity_id: client.id, action, description, changed_by: user.id });
    const email = async (c) => {
      if (!c.email) return 'No email on this client, so the link was not sent. Add one and press Send link.';
      await sendReferralLink(admin, { to: c.email, name: c.name, link: `${publicBaseUrl()}/refer.html?r=${c.referral_token}`, how: HOW[c.lead_reward_kind] || HOW.off });
      await log('referral_link_sent', `Referral link emailed to ${c.email}`);
      return null;
    };

    if (body.action === 'set_kind') {
      if (!KINDS.includes(body.kind)) return json(400, { ok: false, error: 'Off or On.' });
      const { error } = await admin.from('clients').update({ lead_reward_kind: body.kind }).eq('id', client.id);
      if (error) throw error;
      await log('lead_reward_kind', `Lead reward turned ${body.kind === 'off' ? 'off' : 'on (a credit off their next invoice)'}`);
      let warning = null;
      if (client.lead_reward_kind === 'off' && body.kind !== 'off') warning = await email({ ...client, lead_reward_kind: body.kind });
      return json(200, { ok: true, emailed: !warning && client.lead_reward_kind === 'off' && body.kind !== 'off', warning });
    }
    if (body.action === 'send') {
      const warning = await email(client);
      return json(200, { ok: !warning, error: warning || undefined });
    }
    if (body.action === 'regenerate') {
      const token = crypto.randomBytes(16).toString('hex');
      const { error } = await admin.from('clients').update({ referral_token: token }).eq('id', client.id);
      if (error) throw error;
      await log('referral_link_regenerated', 'Referral link replaced; the old one no longer works');
      return json(200, { ok: true, token });
    }
    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('client-referral failed:', err.message);
    return json(500, { ok: false, error: /not connected/.test(err.message) ? 'sales@ is not connected, so the email could not go.' : err.message });
  }
};
