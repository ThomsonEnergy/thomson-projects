// Charge rate levels (item 46): a quote or job is charged at its level, a percent of the Billable
// Rates (rate_cards, projects.rate_card_id). Every server reader of billable_rate_tiers.sell_rate for
// a job goes through here, so the figure the client is charged is the same one everywhere:
// fixed-variation-lines.js, invoice-items.js, variation-lines.js, get-invoiceable-actuals.js.
// Reads only.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// { id, name, percent, factor } for the job, Standard (factor 1) when it has no level.
async function rateCardFor(supabaseAdmin, projectId) {
  const none = { id: null, name: 'Standard', percent: 100, factor: 1 };
  if (!projectId) return none;
  const { data } = await supabaseAdmin.from('projects').select('rate_card_id, rate_cards(id, name, percent)').eq('id', projectId).maybeSingle();
  const rc = data?.rate_cards;
  if (!rc || !(Number(rc.percent) > 0)) return none;
  return { id: rc.id, name: rc.name, percent: Number(rc.percent), factor: Number(rc.percent) / 100 };
}

// The tier's $/hr at the level, rounded to the cent.
const rateAt = (sellRate, factor) => r2((Number(sellRate) || 0) * (Number(factor) || 1));

module.exports = { rateCardFor, rateAt };
