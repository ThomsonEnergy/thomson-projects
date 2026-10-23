// POST /.netlify/functions/check-solar-compliance
// Body: { projectId, phase: 'quote' | 'handover' }
// Pricing-role gated, same as other quote-adjacent functions. Runs the
// project against the deterministic rule set in
// _shared/solar-compliance-rules.js (every quote type: pre-quote answers,
// pricing, terms; plus the solar and battery rules) and returns which
// requirements are met and which are missing, so the quote/job page can
// show the PM exactly what's outstanding and offer to turn the gaps into
// job_tasks (see generate-solar-tasks.js). The same call is the
// ready-to-send gate before a quote is emailed or moved to Quote Sent.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { evaluate } = require('./_shared/solar-compliance-rules');
const { quoteHasBattery } = require('../../public/js/template-questions.js');

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

    const [{ data: project, error: projErr }, { data: docs }, { data: licences }, { data: assets }, { data: photos }] = await Promise.all([
      supabaseAdmin.from('projects').select('*, cost_centres(*, cost_centre_line_items(ai_suggested, description, quantity, prebuild_client_description))').eq('id', projectId).single(),
      supabaseAdmin.from('project_documents').select('folder').eq('project_id', projectId),
      supabaseAdmin.from('profile_licences').select('licence_name, profiles!profile_licences_profile_id_fkey!inner(active)').eq('profiles.active', true),
      supabaseAdmin.from('customer_assets').select('asset_type, serial_numbers').eq('project_id', projectId),
      supabaseAdmin.from('project_photos').select('caption').eq('project_id', projectId).ilike('caption', '%battery%'),
    ]);
    if (projErr || !project) throw projErr || new Error('Project not found');

    const pylonData = project.pylon_data || {};
    const equipment = {
      panels: pylonData.module_types || [],
      inverters: pylonData.inverter_types || [],
      batteries: pylonData.storage_types || [],
    };

    const template = project.proposal_template || 'new_build';
    const answers = project.template_answers || {};
    const solarCentres = (project.cost_centres || []).filter(
      (c) => c.stc_system_kw != null || c.stc_total != null || c.stc_quantity != null
    );
    const quotedTotal = (project.cost_centres || []).reduce((s, c) => s + (Number(c.quoted_amount) || 0), 0);
    const licenceNames = (licences || []).map((l) => l.licence_name || '');

    const ctx = {
      project,
      template,
      answers,
      withBattery: quoteHasBattery(template, answers),
      equipment,
      solarCentres,
      quotedTotal,
      unconfirmedAiLines: (project.cost_centres || []).reduce((n, c) => n + (c.cost_centre_line_items || []).filter((li) => li.ai_suggested).length, 0),
      hasAccreditedStaff:
        licenceNames.some((n) => /saa|accreditation/i.test(n)) &&
        licenceNames.some((n) => /electrical/i.test(n)),
      // A licence row named with SAA (or accreditation) and battery, for example "SAA accreditation - battery endorsement".
      hasBatteryAccreditedStaff: licenceNames.some((n) => /saa|accreditation/i.test(n) && /batter/i.test(n)),
      hasBatteryAssetSerial: (assets || []).some((a) => /batter/i.test(a.asset_type || '') && (a.serial_numbers || '').trim()),
      hasBatteryLocationPhoto: (photos || []).length > 0,
      hasComplianceCertDoc: (docs || []).some((d) => d.folder === 'Compliance certificate'), // legacy folder only; the rule reads projects.ccew_file_path first
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
