// The deterministic rule set behind the solar compliance checklist -
// distilled from SOLAR_QUOTE_COMPLIANCE_REQUIREMENTS.md (the actual NETCC
// and Clean Energy Regulator source material, researched separately).
// Kept as plain JS rather than re-fetched from those sources at runtime,
// and kept deterministic on purpose - whether a solar quote is missing a
// legally required piece of information should never depend on an LLM's
// judgement. This file is the thing to update by hand if NETCC/CER
// requirements change; review it against the compliance doc periodically.
//
// Each rule only covers something that is actually stored as data in this
// app. Process/behavioural NETCC obligations (no high-pressure selling,
// identify yourself on an unsolicited visit, etc.) aren't checkable here
// and stay as staff training, not a checklist item.
//
// `check(ctx)` returns true when the requirement is satisfied. `ctx` is
// built by check-solar-compliance.js - see the shape documented there.

const QUOTE_RULES = [
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
    label: 'Enter the STC system size/zone rating on every stage that includes solar, so the STC credit shown to the client is real, not blank',
    check: (ctx) => ctx.solarCentres.every((c) => Number(c.stc_system_kw) > 0 && Number(c.stc_total) > 0),
  },
  {
    id: 'terms_present',
    label: 'Confirm the quote has terms and conditions text (warranty details, cooling-off rights) - prefilled from Settings, but check it hasn\'t been cleared for this job',
    check: (ctx) => !!(ctx.project.terms_text || '').trim(),
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
  {
    id: 'compliance_certificate_uploaded',
    label: 'Upload the signed electrical safety compliance certificate',
    check: (ctx) => ctx.hasComplianceCertDoc,
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

function evaluate(phase, ctx) {
  const rules = phase === 'quote' ? QUOTE_RULES : HANDOVER_RULES;
  return rules.map((r) => ({ id: r.id, label: r.label, met: !!r.check(ctx) }));
}

module.exports = { QUOTE_RULES, HANDOVER_RULES, evaluate };
