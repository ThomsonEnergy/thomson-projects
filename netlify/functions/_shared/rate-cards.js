// Charge rate levels and commercial agreements (items 46 and 48): a quote or job has a level
// (rate_cards, projects.rate_card_id), a percent of the Schedule of Rates (the Billable Rates).
//   over 100%   a surcharge level, folded into every $/hr (Commercial 115%: $138 instead of $120)
//   under 100%  a commercial agreement, an efficiency reduction: fixed-price quotes and fixed
//               variations still fold it into the price (the client sees a lump sum), but do and
//               charge work is billed at the full Schedule of Rates $/hr with one minus line per
//               claim, "Commercial agreement (name): 10% off labour" (invoice-items.js,
//               create-invoice.js), so the rates never look inflated and the line can be withdrawn.
// Every server reader of billable_rate_tiers.sell_rate for a job goes through here, so the figure
// the client is charged is the same one everywhere: fixed-variation-lines.js and variation-lines.js
// (factor), invoice-items.js and get-invoiceable-actuals.js (labourFactor and percentOff). Reads only.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// { id, name, percent, factor, labourFactor, percentOff } for the job, Standard when it has no level:
//   factor        percent / 100, for a lump-sum price (quotes, fixed variations)
//   labourFactor  the surcharge only (1 under a commercial agreement), for a do and charge $/hr
//   percentOff    the agreement's reduction (0 when there is none), for the invoice's minus line
async function rateCardFor(supabaseAdmin, projectId) {
  const none = { id: null, name: 'Standard', percent: 100, factor: 1, labourFactor: 1, percentOff: 0 };
  if (!projectId) return none;
  const { data, error } = await supabaseAdmin.from('projects').select('rate_card_id, rate_cards(id, name, percent)').eq('id', projectId).maybeSingle();
  if (error) throw error;  // a money path: never fall back to Standard on a failed read
  const rc = data?.rate_cards;
  const percent = Number(rc?.percent);
  if (!rc || !(percent > 0)) return none;
  return {
    id: rc.id, name: rc.name, percent, factor: percent / 100,
    labourFactor: percent > 100 ? percent / 100 : 1,
    percentOff: percent < 100 ? Math.round((100 - percent) * 10) / 10 : 0,
  };
}

// The tier's $/hr at the level, rounded to the cent.
const rateAt = (sellRate, factor) => r2((Number(sellRate) || 0) * (Number(factor) || 1));

module.exports = { rateCardFor, rateAt };
