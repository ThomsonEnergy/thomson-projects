// POST /.netlify/functions/lead-reward   (Admin, Finance and Sales; backlog item 74b, step 3b part 2)
// The two things a person does to a lead reward, from the Clients page:
//   { action: 'cancel', rewardId, reason }  cancel a reward not yet on an invoice; its credit note is
//        voided in Xero first, so the books and the app agree
//   { action: 'retry' }                     run the worker's pass now (after fixing what Xero refused,
//        or to see a new reward go without waiting 15 minutes)
// Everything else about a reward happens by itself (_shared/lead-rewards.js, lead-rewards-background.js).

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { cancelReward, runLeadRewards } = require('./_shared/lead-rewards');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin: admin, user } = auth;
  try {
    const body = JSON.parse(event.body || '{}');
    if (body.action === 'cancel') {
      if (!UUID.test(body.rewardId || '')) return json(400, { ok: false, error: 'Which reward?' });
      await cancelReward(admin, { rewardId: body.rewardId, reason: body.reason, actorId: user.id });
      return json(200, { ok: true });
    }
    if (body.action === 'retry') {
      const r = await runLeadRewards(admin, { limit: 20, force: true });
      if (!r.on) return json(200, { ok: false, error: 'Pick the account on the Lead rewards row in Settings > Xero Mapping first.' });
      return json(200, { ok: !r.failed, error: r.failed ? r.errors.slice(0, 3).join('; ') : undefined, result: r });
    }
    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('lead-reward failed:', err.message);
    return json(400, { ok: false, error: err.message });
  }
};
