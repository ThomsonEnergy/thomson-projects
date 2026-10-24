// Downloads every retailer's current electricity market plans on the NSW and QLD networks from
// the AER's Consumer Data Right product data into energy_plans, for the plan suggestions on a quote
// (docs/IDEAS_BACKLOG.md item 34). Started by sync-energy-plans.js about once a day.
//
// Only the sweep may start it: the call carries the internal secret (_shared/require-internal.js), so a
// stranger cannot start twenty parallel 13 minute downloads. It also does nothing when a download is
// running or ran recently (the same check as the sweep).
//
// Only plans that changed since the last download are fetched in full. Each run is logged in
// energy_plan_sync_runs with counts, errors and a few raw samples of what the feed returned.

const { getAdminClient } = require('./_shared/require-admin');
const { requireInternal } = require('./_shared/require-internal');
const { due } = require('./sync-energy-plans');
const { CONVERTER_VERSION, NETWORKS, networkKey, discoverBrands, listPlans, fetchPlanDetail, convertPlan, expandPostcodes } = require('./_shared/energy-plans');

const BUDGET_MS = 13 * 60000;
const clip = (v, n = 12000) => { try { const t = JSON.stringify(v); return t.length > n ? t.slice(0, n) + '...' : t; } catch (_) { return null; } };

async function pool(items, size, fn, stop) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length && !stop()) { const k = i++; await fn(items[k], k); }
  });
  await Promise.all(workers);
}

exports.handler = async (event) => {
  if (!requireInternal(event)) return { statusCode: 403, body: 'Forbidden' };
  const admin = getAdminClient();
  const { data: last } = await admin.from('energy_plan_sync_runs').select('status, started_at').order('started_at', { ascending: false }).limit(1).maybeSingle();
  if (!due(last)) return { statusCode: 200, body: 'Not due' };
  const { data: run, error: runErr } = await admin.from('energy_plan_sync_runs').insert({ status: 'running' }).select('id').single();
  if (runErr) { console.error(runErr); return { statusCode: 500, body: runErr.message }; }
  const started = Date.now();
  const outOfTime = () => Date.now() - started > BUDGET_MS;
  const errors = [];
  const samples = { lists: [], details: [] };
  const counts = { brands: 0, plans_listed: 0, plans_fetched: 0, plans_saved: 0 };
  const finish = (status) => admin.from('energy_plan_sync_runs').update({ status, finished_at: new Date().toISOString(), errors: errors.slice(0, 200), samples, ...counts }).eq('id', run.id);
  try {
    const { brands, source, why } = await discoverBrands();
    if (why) errors.push({ step: 'brands', error: why });
    await admin.from('energy_plan_sync_runs').update({ source }).eq('id', run.id);
    counts.brands = brands.length;

    // what is stored now, so unchanged plans are not fetched again
    const stored = new Map();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from('energy_plans').select('plan_id, last_updated, costable, active, converter:notes->converter').range(from, from + 999);
      if (error) throw new Error(error.message);
      (data || []).forEach(p => stored.set(p.plan_id, p));
      if (!data || data.length < 1000) break;
    }

    // every brand's plan list, kept to the networks we quote on
    const queue = [];
    const listedBrands = new Set();
    await pool(brands, 6, async (brand) => {
      try {
        const plans = await listPlans(brand);
        listedBrands.add(brand.id);
        if (samples.lists.length < 3 && plans.length) samples.lists.push({ brand: brand.id, count: plans.length, first: clip(plans[0], 4000) });
        plans.forEach(p => {
          const type = String(p.customerType || '').toUpperCase();
          if (type && type !== 'RESIDENTIAL' && type !== 'BUSINESS') return;
          const nets = ((p.geography && p.geography.distributors) || []).map(networkKey).filter(Boolean);
          if (p.geography && (p.geography.distributors || []).length && !nets.length) return;
          counts.plans_listed++;
          queue.push({ brand, summary: p, nets });
        });
      } catch (err) {
        errors.push({ brand: brand.id, step: 'list', error: String(err.message || err).slice(0, 300) });
      }
    }, outOfTime);

    // the full plan for anything new or changed; a batch of rows is written at a time
    const seen = new Set();
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const rows = batch; batch = [];
      const { error } = await admin.from('energy_plans').upsert(rows, { onConflict: 'plan_id' });
      if (error) errors.push({ step: 'save', error: error.message.slice(0, 300) }); else counts.plans_saved += rows.length;
    };
    // a plan put away earlier that is published again unchanged: switched back on without a fetch
    const backOn = [];
    await pool(queue, 10, async ({ brand, summary, nets }) => {
      const id = summary.planId;
      if (!id) return;
      seen.add(id);
      const had = stored.get(id);
      // unchanged since the last download, and converted by this version of the converter
      if (had && Number(had.converter) >= CONVERTER_VERSION && summary.lastUpdated && had.last_updated && new Date(had.last_updated).getTime() >= new Date(summary.lastUpdated).getTime()) {
        if (had.active === false) backOn.push(id);
        return;
      }
      try {
        const { detail, version } = await fetchPlanDetail(brand, id);
        if (!detail) { errors.push({ brand: brand.id, plan: id, step: 'detail', error: 'no detail' }); return; }
        counts.plans_fetched++;
        if (samples.details.length < 3) samples.details.push({ brand: brand.id, version, detail: clip(detail, 12000) });
        const c = convertPlan(detail);
        const geo = detail.geography || summary.geography || {};
        const distributors = [...new Set([...(geo.distributors || []).map(d => networkKey(d) || d), ...nets])];
        if (distributors.length && !distributors.some(d => NETWORKS.some(n => n.key === d))) return;
        batch.push({
          plan_id: id,
          brand: brand.id,
          brand_name: detail.brandName || summary.brandName || brand.name,
          display_name: detail.displayName || summary.displayName || id,
          customer_type: String(detail.customerType || summary.customerType || '').toUpperCase() || null,
          pricing_model: (detail.electricityContract && detail.electricityContract.pricingModel) || detail.pricingModel || summary.pricingModel || null,
          distributors,
          included_postcodes: expandPostcodes(geo.includedPostcodes),
          excluded_postcodes: expandPostcodes(geo.excludedPostcodes),
          effective_from: detail.effectiveFrom || summary.effectiveFrom || null,
          effective_to: detail.effectiveTo || summary.effectiveTo || null,
          last_updated: detail.lastUpdated || summary.lastUpdated || null,
          roi_plan: c.roi_plan,
          adjust: c.adjust,
          notes: c.notes,
          costable: c.costable,
          active: true,
          fetched_at: new Date().toISOString(),
        });
        if (batch.length >= 200) await flush();
      } catch (err) {
        errors.push({ brand: brand.id, plan: id, step: 'detail', error: String(err.message || err).slice(0, 300) });
      }
    }, outOfTime);
    await flush();
    for (let k = 0; k < backOn.length; k += 500) {
      const { error } = await admin.from('energy_plans').update({ active: true }).in('plan_id', backOn.slice(k, k + 500));
      if (error) errors.push({ step: 'reactivate', error: error.message.slice(0, 300) });
    }

    // plans a listed brand no longer publishes are put away (kept for quotes that already show them).
    // A brand whose list failed (any HTTP error, logged above) is not in listedBrands, so its plans stay as they are.
    if (!outOfTime()) {
      const gone = [...stored.keys()].filter(id => !seen.has(id));
      for (let k = 0; k < gone.length; k += 500) {
        const ids = gone.slice(k, k + 500);
        const { data: rows } = await admin.from('energy_plans').select('plan_id, brand').in('plan_id', ids);
        const off = (rows || []).filter(r => listedBrands.has(r.brand)).map(r => r.plan_id);
        if (off.length) await admin.from('energy_plans').update({ active: false }).in('plan_id', off);
      }
    }
    await finish(outOfTime() ? 'partial' : (listedBrands.size ? 'ok' : 'failed'));
    return { statusCode: 200, body: 'Done' };
  } catch (err) {
    console.error(err);
    errors.push({ step: 'run', error: String(err.message || err).slice(0, 500) });
    await finish('failed');
    return { statusCode: 500, body: 'Failed' };
  }
};
