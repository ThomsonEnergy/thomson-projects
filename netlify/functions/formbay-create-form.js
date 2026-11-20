// POST /.netlify/functions/formbay-create-form  (pricing roles; the job's STCs tab, public/js/formbay-card.js)
//   { action: 'options', projectId }                  people, brands and the job's details for the panel
//   { action: 'list', list, brand, series }           Formbay's own panel, inverter and battery lists
//   { action: 'create', projectId, fields }           make the solar, battery or solar and battery form in Formbay as a draft
// Create is the only thing in the app that writes to Formbay. It signs and submits nothing: those
// stay in Formbay's app, as they are the installer's declaration. The how is in _shared/formbay-sync.js.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { formbayLogin } = require('./_shared/formbay');
const { createOptions, createForm, equipmentList } = require('./_shared/formbay-sync');

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
    if (action === 'list') return answer(200, await equipmentList(token, input.list, input));
    if (!projectId) return answer(400, { ok: false, error: 'projectId is required' });
    if (action === 'options') return answer(200, await createOptions(db, token, projectId));
    if (action === 'create') return answer(200, await createForm(db, token, { projectId, userId: auth.user.id, f: input.fields || {} }));
    return answer(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('formbay-create-form:', err);
    return answer(500, { ok: false, error: String(err.message || err) });
  }
};
