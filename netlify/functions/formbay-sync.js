// POST /.netlify/functions/formbay-sync  (pricing roles; the job's STCs tab, public/js/formbay-card.js)
//   { action: 'find', projectId }             Formbay battery forms not on a job yet, this job's address first
//   { action: 'link', projectId, formId }     put that form on this job and read it
//   { action: 'refresh', projectId }          read this job's forms again now
// Reads from Formbay only. The how is in _shared/formbay-sync.js.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { formbayLogin } = require('./_shared/formbay');
const { syncForm, findForms } = require('./_shared/formbay-sync');

const answer = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return answer(405, { ok: false, error: 'Method not allowed' });
  const auth = await requirePricingRole(event);
  if (!auth) return answer(403, { ok: false, error: 'Not authorized' });
  let input;
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return answer(400, { ok: false, error: 'Bad request' }); }
  const { action, projectId, formId } = input;
  if (!projectId) return answer(400, { ok: false, error: 'projectId is required' });
  const db = auth.supabaseAdmin;

  try {
    const token = await formbayLogin();
    if (action === 'find') return answer(200, await findForms(db, token, projectId));
    if (action === 'link') {
      if (!/^\d{1,12}$/.test(String(formId || '').trim())) return answer(400, { ok: false, error: 'The Formbay job number is digits only.' });
      return answer(200, await syncForm(db, token, { formId, projectId, userId: auth.user.id }));
    }
    if (action === 'refresh') {
      const { data: rows, error } = await db.from('formbay_forms').select('formbay_job_id').eq('project_id', projectId);
      if (error) throw error;
      const results = [];
      for (const row of rows || []) results.push(await syncForm(db, token, { formId: row.formbay_job_id }));
      const failed = results.find(r => !r.ok);
      return answer(200, failed ? { ok: false, error: failed.error } : { ok: true });
    }
    return answer(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('formbay-sync:', err);
    return answer(500, { ok: false, error: String(err.message || err) });
  }
};
