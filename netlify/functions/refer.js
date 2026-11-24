// POST /.netlify/functions/refer   (public: the client's private referral token is the check)
// The referral link's server side (backlog item 74b, step 3a). Body { r: <token>, action }:
//   info    -> { client: first word of the company name, rewards: what each choice earns, or null,
//               types }: all the page needs, nothing else about the client
//   submit  -> a referral (a lead in the client's name) or their own job (a draft quote), see
//              _shared/referrals.js; 10 an hour per link
// The link reads nothing back about past referrals: that list is behind the portal login.
// Body { s: <token> } is a staff member's personal link (item 74b 7a): info gives their first name,
// the "how did you hear about us" choices and the team's first names; submit makes a lead that is theirs.

const { getAdminClient } = require('./_shared/require-admin');
const F = require('./_shared/referrals');

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Bad request' }); }
  const admin = getAdminClient();
  try {
    // mapsKey: Google's browser key, so the address box offers addresses (item 103); it goes only to
    // someone holding a working link
    const mapsKey = async () => { const { data } = await admin.from('company_settings').select('google_maps_api_key').eq('id', 1).maybeSingle(); return (data && data.google_maps_api_key) || ''; };
    if (body.s) {
      const staff = await F.staffForToken(admin, body.s);
      if (!staff) return json(404, { ok: false, error: 'This link is not working any more. Please call us instead.' });
      if (body.action === 'info') return json(200, { ok: true, ...F.publicInfo(await F.staffLinkInfo(admin, staff)), types: F.TYPES, mapsKey: await mapsKey() });
      if (body.action === 'submit') { await F.submitStaffLead(admin, staff, body); return json(200, { ok: true, kind: 'lead' }); }
      return json(400, { ok: false, error: 'Unknown action' });
    }
    const client = await F.clientForToken(admin, body.r);
    if (!client) return json(404, { ok: false, error: 'This link is not working any more. Please ask us for a new one.' });
    if (body.action === 'info') {
      return json(200, { ok: true, client: client.name, rewards: await F.rewardTerms(admin, client), types: F.TYPES, mapsKey: await mapsKey() });
    }
    if (body.action === 'submit') {
      const out = await F.submitReferral(admin, client, body);
      return json(200, { ok: true, kind: out.kind, ref: out.ref || null });
    }
    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    if (err.statusCode === 400) return json(400, { ok: false, error: err.message });
    console.error('refer failed:', err);
    return json(500, { ok: false, error: 'Something went wrong. Please try again, or call us.' });
  }
};
