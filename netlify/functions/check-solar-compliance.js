// POST /.netlify/functions/check-solar-compliance
// Body: { projectId, phase: 'quote' | 'handover' }
// Pricing-role gated, same as other quote-adjacent functions. Runs the
// project against the deterministic rule set in
// _shared/solar-compliance-rules.js and returns which requirements are
// met and which are missing, so the quote/job page can show the PM
// exactly what's outstanding and offer to turn the gaps into job_tasks
// (see generate-solar-tasks.js).

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { evaluate } = require('./_shared/solar-compliance-rules');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requirePricingRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }

  try {
    const { projectId, phase } = JSON.parse(event.body || '{}');
    if (!projectId || !['quote', 'handover'].includes(phase)) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'projectId and a valid phase are required' }) };
    }

    const { supabaseAdmin } = auth;

    const [{ data: project, error: projErr }, { data: docs }, { data: licences }] = await Promise.all([
      supabaseAdmin.from('projects').select('*, cost_centres(*)').eq('id', projectId).single(),
      supabaseAdmin.from('project_documents').select('folder').eq('project_id', projectId),
      supabaseAdmin.from('profile_licences').select('licence_name, profiles!inner(active)').eq('profiles.active', true),
    ]);
    if (projErr || !project) throw projErr || new Error('Project not found');

    const pylonData = project.pylon_data || {};
    const equipment = {
      panels: pylonData.module_types || [],
      inverters: pylonData.inverter_types || [],
      batteries: pylonData.storage_types || [],
    };

    const solarCentres = (project.cost_centres || []).filter(
      (c) => c.stc_system_kw != null || c.stc_total != null
    );
    const quotedTotal = (project.cost_centres || []).reduce((s, c) => s + (Number(c.quoted_amount) || 0), 0);

    const ctx = {
      project,
      equipment,
      solarCentres,
      quotedTotal,
      hasAccreditedStaff:
        (licences || []).some((l) => /saa|accreditation/i.test(l.licence_name || '')) &&
        (licences || []).some((l) => /electrical/i.test(l.licence_name || '')),
      hasComplianceCertDoc: (docs || []).some((d) => d.folder === 'Compliance certificate'),
      hasOwnerDeclarationDoc: (docs || []).some((d) => d.folder === 'Owner STC declaration'),
    };

    const results = evaluate(phase, ctx);
    const missing = results.filter((r) => !r.met);
    const present = results.filter((r) => r.met);

    return { statusCode: 200, body: JSON.stringify({ ok: true, missing, present }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
