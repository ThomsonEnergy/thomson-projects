// POST /.netlify/functions/client-cleanup
// Body: { action, ... }
// The review lists behind the Clients page's clean-up buttons (backlog item 110). Checks the
// caller, then calls _shared/client-duplicates.js and _shared/client-abns.js, which own how. The
// scans themselves run in client-cleanup-background.js.
//   Pricing roles:  abns                    the ABNs waiting for review
//                   apply-abns { items }    save the ticked ones ([{ clientId, abn }])
//                   no-abn { clientId }     "None of these": not offered again
//                   counts                  how many of each are waiting
//   Admin only:     duplicates              the pairs waiting for review
//                   dismiss-duplicate { id }  "Not the same": not offered again
// Merging itself is the database function client_merge (Admin only), called from the page.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { listDuplicates, dismissDuplicate } = require('./_shared/client-duplicates');
const { listAbns, applyAbns, noAbn } = require('./_shared/client-abns');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin: admin, user } = auth;
  try {
    const input = JSON.parse(event.body || '{}');
    const { data: me } = await admin.from('profiles').select('role').eq('id', user.id).single();
    const isAdmin = !!me && me.role === 'admin';

    if (input.action === 'counts') {
      const [abns, dupes] = await Promise.all([
        listAbns(admin),
        isAdmin ? admin.from('client_merge_suggestions').select('id', { count: 'exact', head: true }).eq('status', 'open').neq('verdict', 'apart') : Promise.resolve({ count: 0 }),
      ]);
      return json(200, { ok: true, abns: abns.length, duplicates: dupes.count || 0, isAdmin });
    }
    if (input.action === 'abns') return json(200, { ok: true, rows: await listAbns(admin) });
    if (input.action === 'apply-abns') return json(200, { ok: true, ...(await applyAbns(admin, user.id, input.items)) });
    if (input.action === 'no-abn') {
      if (!UUID.test(input.clientId || '')) return json(400, { ok: false, error: 'clientId is required' });
      return json(200, await noAbn(admin, user.id, input.clientId));
    }

    if (!isAdmin) return json(403, { ok: false, error: 'Only Admin can merge clients.' });
    if (input.action === 'duplicates') return json(200, { ok: true, rows: await listDuplicates(admin) });
    if (input.action === 'dismiss-duplicate') {
      if (!UUID.test(input.id || '')) return json(400, { ok: false, error: 'id is required' });
      return json(200, await dismissDuplicate(admin, input.id, user.id));
    }
    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('client-cleanup error:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
