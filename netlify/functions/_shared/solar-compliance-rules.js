// The deterministic rule set behind the ready-to-send check and the handover checklist:
// distilled from docs/SOLAR_QUOTE_COMPLIANCE_REQUIREMENTS.md (NETCC and the Clean Energy
// Regulator) and docs/BATTERY_QUOTE_COMPLIANCE_REQUIREMENTS.md (Cheaper Home Batteries Program,
// SAA battery endorsement, AS/NZS 5139). Kept as plain JS rather than re-fetched from those
// sources at runtime, and kept deterministic on purpose: whether a quote is missing a legally
// required piece of information should never depend on an LLM's judgement. This file is the
// thing to update by hand if the rules change; review it against the docs periodically.
//
// Each rule only covers something that is actually stored as data in this app. Process /
// behavioural obligations (no high-pressure selling, identify yourself on an unsolicited visit)
// are not checkable here and stay as staff training.
//
// `check(ctx)` returns true when the requirement is satisfied. `ctx` is built by
// check-solar-compliance.js (quote page) and create-default-job-tasks.js (job creation):
//   project, template, answers (projects.template_answers), withBattery, equipment
//   { panels, inverters, batteries } from Pylon, solarCentres, quotedTotal, hasAccreditedStaff,
//   hasBatteryAccreditedStaff, hasComplianceCertDoc, hasOwnerDeclarationDoc.

const { missingRequiredAnswers, quoteHasBattery } = require('../../../public/js/template-questions.js');

const yes = (ctx, id) => (ctx.answers || {})[id] === 'Yes';
const num = (ctx, id) => parseFloat((ctx.answers || {})[id]);

// Every quote type.
const GENERAL_QUOTE_RULES = [
  {
    id: 'prequote_answers',
    label: 'Answer the pre-quote questions marked * (the ones still blank are listed on the quote)',
    check: (ctx) => missingRequiredAnswers(ctx.template, ctx.answers).length === 0,
    // The gaps themselves, so the list on the page names each question.
    detail: (ctx) => missingRequiredAnswers(ctx.template, ctx.answers).map((m) => m.label),
  },
  {
    id: 'priced_stage',
    label: 'Add at least one priced stage (the quoted total is $0)',
    check: (ctx) => ctx.quotedTotal > 0,
  },
  {
    id: 'terms_present',
    label: 'Confirm the quote has terms and conditions text (warranty details, cooling-off rights) - prefilled from Settings, but check it hasn\'t been cleared for this job',
    check: (ctx) => !!(ctx.project.terms_text || '').trim(),
  },
  {
    id: 'ai_lines_confirmed',
    label: 'Confirm or remove the prebuilds the AI added (tagged "AI added, check" on the stages)',
    check: (ctx) => !(ctx.unconfirmedAiLines > 0),
  },
];

// Solar proposals (and the solar side of a Solar + Batteries quote).
const SOLAR_QUOTE_RULES = [
  {
    id: 'pylon_design_linked',
    label: 'Link the Pylon design (satisfies the NETCC site-specific design/plan requirement)',
    check: (ctx) => !!ctx.project.pylon_project_id,
  },
  {
    id: 'equipment_specified',
    label: 'Pull equipment from Pylon so the quote lists real panel/inverter/battery models, not a placeholder description',
    check: (ctx) => ctx.equipment.panels.length > 0 || ctx.equipment.inverters.length > 0 || ctx.equipment.batteries.length > 0,
  },
  {
    id: 'deposit_and_price_set',
    label: 'Set a deposit % and confirm the quoted total is more than $0',
    check: (ctx) => Number(ctx.project.deposit_percent) > 0 && ctx.quotedTotal > 0,
  },
  {
    id: 'stc_figures_present',
    label: 'Enter the STC count (or system size) and $ per STC on the quote\'s STC credit, so the credit shown to the client is real, not blank',
    check: (ctx) => (Number(ctx.project.stc_quantity) > 0 || Number(ctx.project.stc_system_kw) > 0) && Number(ctx.project.stc_total) > 0,
  },
];

// Battery proposals, and a Solar proposal with Batteries as well. Sources: CER Cheaper Home
// Batteries Program (from 1 July 2025, changed 1 May 2026: 5 to 100 kWh usable with the discount
// on the first 50 kWh, CEC approved list, VPP capable, one claim per premises, solar commissioned
// before or with the battery, designer and installer accredited with SAA for grid connected
// battery systems), AS/NZS 5139 (location and clearances).
const BATTERY_QUOTE_RULES = [
  {
    id: 'battery_model_specified',
    label: 'Pull the battery from Pylon (or link the Pylon design) so the quote names the battery make and model',
    check: (ctx) => ctx.equipment.batteries.length > 0 || !!ctx.project.pylon_project_id,
  },
  {
    id: 'battery_size_in_range',
    label: 'Usable battery size must be 5 to 100 kWh for the federal battery discount, which covers the first 50 kWh (answer "Usable kWh wanted")',
    check: (ctx) => { const k = num(ctx, 'battery_kwh_wanted'); return k >= 5 && k <= 100; },
  },
  {
    id: 'battery_cec_listed',
    label: 'Confirm the battery is on the CEC approved product list (answer Yes on the pre-quote card)',
    check: (ctx) => yes(ctx, 'cec_listed'),
  },
  {
    id: 'battery_vpp_capable',
    label: 'Confirm the battery or its inverter is VPP capable (required for the federal discount)',
    check: (ctx) => yes(ctx, 'vpp_capable'),
  },
  {
    id: 'battery_first_at_premises',
    label: 'Confirm this is the first battery discount claim at this address (one claim per premises)',
    check: (ctx) => yes(ctx, 'first_battery'),
  },
  {
    id: 'battery_solar_first',
    label: 'Confirm the solar is commissioned before or with the battery (a battery with no solar is not eligible)',
    check: (ctx) => yes(ctx, 'solar_commissioned_first'),
  },
  {
    id: 'battery_location_clear',
    label: 'Confirm the battery location is clear of habitable rooms, exits and heat with AS/NZS 5139 clearances (answer Yes, or pick another spot)',
    check: (ctx) => yes(ctx, 'location_clear'),
  },
  {
    id: 'bstc_figures_present',
    label: 'Enter the BSTC count and $ per BSTC on the quote\'s BSTC credit (or tick "No BSTC on this quote")',
    check: (ctx) => !!ctx.project.bstc_not_claimed || (Number(ctx.project.bstc_quantity) > 0 && Number(ctx.project.bstc_total) > 0),
  },
  {
    id: 'battery_accreditation_on_file',
    label: 'Have a staff member with SAA grid connected battery systems (GCBS) accreditation on file (Settings > Team: a licence named "SAA ... battery")',
    check: (ctx) => ctx.hasBatteryAccreditedStaff,
  },
];

const HANDOVER_RULES = [
  {
    id: 'nmi_recorded',
    label: 'Record the site\'s National Metering Identifier (NMI) - required for STC creation',
    check: (ctx) => !!(ctx.project.nmi || '').trim(),
  },
  {
    id: 'panel_serials_recorded',
    label: 'Record every installed panel\'s serial number',
    check: (ctx) => !!(ctx.project.panel_serial_numbers || '').trim(),
  },
  {
    id: 'inverter_serials_recorded',
    label: 'Record every installed inverter\'s serial number',
    check: (ctx) => !!(ctx.project.inverter_serial_numbers || '').trim(),
  },
  {
    id: 'accreditation_on_file',
    label: 'Confirm the installer/designer\'s SAA accreditation number and electrical licence number are on file (Settings > Team)',
    check: (ctx) => ctx.hasAccreditedStaff,
  },
  // Reads projects.ccew_file_path (the Compliance - CCEW card on the job Summary tab); hasComplianceCertDoc only keeps a pre-card project_documents folder passing.
  {
    id: 'compliance_certificate_uploaded',
    label: 'Upload the CCEW',
    check: (ctx) => !!ctx.project.ccew_file_path || !!(ctx.project.ccew_not_required_reason || '').trim() || !!ctx.hasComplianceCertDoc,
  },
  {
    id: 'owner_stc_declaration',
    label: 'Get the owner\'s signed STC assignment declaration',
    check: (ctx) => ctx.hasOwnerDeclarationDoc,
  },
  {
    id: 'formbay_lodged',
    label: 'Lodge the job with Formbay for STC compliance submission',
    check: (ctx) => !!ctx.project.formbay_lodgement_status,
  },
];

// Battery handover: a battery-only job has no panels to record; the battery and its inverter
// serials go on the Installed equipment card (customer_assets).
const BATTERY_HANDOVER_RULES = [
  {
    id: 'battery_serials_recorded',
    label: 'Record the battery and inverter serial numbers under Installed equipment on the Summary tab',
    check: (ctx) => !!ctx.hasBatteryAssetSerial,
  },
  {
    id: 'battery_accreditation_on_file',
    label: 'Confirm the installer\'s SAA grid connected battery systems (GCBS) accreditation is on file (Settings > Team)',
    check: (ctx) => ctx.hasBatteryAccreditedStaff,
  },
  {
    id: 'battery_location_photo',
    label: 'Photograph the installed battery location showing the AS/NZS 5139 clearances and signage',
    check: (ctx) => !!ctx.hasBatteryLocationPhoto,
  },
];

function rulesFor(phase, ctx) {
  const template = ctx.template || (ctx.project && ctx.project.proposal_template) || 'new_build';
  const withBattery = ctx.withBattery != null ? ctx.withBattery : quoteHasBattery(template, ctx.answers || {});
  if (phase === 'quote') {
    const rules = [...GENERAL_QUOTE_RULES];
    if (template === 'solar') rules.push(...SOLAR_QUOTE_RULES);
    if (template === 'battery') rules.push(SOLAR_QUOTE_RULES[2]); // a deposit applies to a battery quote too; its certificates are the BSTC rule
    if (withBattery) rules.push(...BATTERY_QUOTE_RULES);
    return rules;
  }
  if (template === 'battery') {
    return [HANDOVER_RULES[0], HANDOVER_RULES[2], ...BATTERY_HANDOVER_RULES, HANDOVER_RULES[4], HANDOVER_RULES[5], HANDOVER_RULES[6]];
  }
  const rules = [...HANDOVER_RULES];
  if (withBattery) rules.push(...BATTERY_HANDOVER_RULES);
  return rules;
}

function evaluate(phase, ctx) {
  return rulesFor(phase, ctx).map((r) => {
    const met = !!r.check(ctx);
    const out = { id: r.id, label: r.label, met };
    if (!met && typeof r.detail === 'function') {
      const detail = r.detail(ctx);
      if (detail && detail.length) out.label = `${r.label}: ${detail.join('; ')}`;
    }
    return out;
  });
}

module.exports = { GENERAL_QUOTE_RULES, SOLAR_QUOTE_RULES, BATTERY_QUOTE_RULES, HANDOVER_RULES, BATTERY_HANDOVER_RULES, QUOTE_RULES: SOLAR_QUOTE_RULES, rulesFor, evaluate };
