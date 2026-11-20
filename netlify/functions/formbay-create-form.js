// POST /.netlify/functions/formbay-create-form  (pricing roles; the job's STCs tab, public/js/formbay-card.js)
//   { action: 'options', projectId }                  people, battery brands and the job's details for the panel
//   { action: 'series', brand } / { action: 'models', brand, series }   Formbay's own battery lists
//   { action: 'create', projectId, fields }           make the battery (BSTC) form in Formbay as a draft
// Create is the only thing in the app that writes to Formbay. It signs and submits nothing: those
// stay in Formbay's app, as they are the installer's declaration. The how is in _shared/formbay-sync.js.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { formbayLogin, formbayCall } = require('./_shared/formbay');
const { createOptions, createForm } = require('./_shared/formbay-sync');

const answer = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return answer(405, { ok: false, error: 'Method not allowed' });
  const auth = await requirePricingRole(event);
  if (!auth) return answer(403, { ok: false, error: 'Not authorized' });
  let input;
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return answer(400, { ok: false, error: 'Bad request' }); }
  const { action, projectId } = input;
  const db = auth.supabaseAdmin;

  try {
    const token = await formbayLogin();
    if (action === 'series' || action === 'models') {
      const q = new URLSearchParams({ b_brand: String(input.brand || ''), bstc: 1 });
      if (action === 'models') q.set('b_series', String(input.series || ''));
      const r = await formbayCall(token, `pv_inverter_battery_${action}?${q}`);
      return answer(200, Array.isArray(r.json) ? { ok: true, list: r.json } : { ok: false, error: 'Formbay did not send its list. Try again.' });
    }
    if (!projectId) return answer(400, { ok: false, error: 'projectId is required' });
    if (action === 'options') return answer(200, await createOptions(db, token, projectId));
    if (action === 'create') return answer(200, await createForm(db, token, { projectId, userId: auth.user.id, f: input.fields || {} }));
    return answer(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('formbay-create-form:', err);
    return answer(500, { ok: false, error: String(err.message || err) });
  }
};
