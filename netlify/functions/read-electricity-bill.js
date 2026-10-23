// POST /.netlify/functions/read-electricity-bill
// Body: { projectId }
// Reads every page of the customer's electricity bill filed on the quote (project_documents in
// the "Electricity bill" folder, private project-documents bucket) in one Claude call, saves
// the reading on projects.bill_reading with the solar and battery sizes worked out in code
// (public/js/solar-roi.js), and fills the pre-quote answers the bill can answer when they are
// still blank (NMI, daily use, supply, network, existing solar). Pricing roles only: it spends
// the Anthropic key and reads private job documents. See docs/IDEAS_BACKLOG.md item 29.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { requirePricingRole } = require('./_shared/require-pricing-role');
const { suggestSizes, billMetrics } = require('../../public/js/solar-roi.js');

const BILL_FOLDER = 'Electricity bill';
const MAX_PAGES = 12;

function mimeFor(path, stored) {
  if (stored && /^(application\/pdf|image\/(png|jpeg|webp|gif))$/.test(stored)) return stored;
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return null;
}

const PROMPT = `These are the pages of a customer's electricity bill from an Australian energy retailer (several photos or one PDF; the pages may be out of order and may repeat). Read every page and return ONE JSON object with these fields. Use null for anything not shown. Numbers are plain numbers, not strings, and never guessed: if a figure is not printed on the bill, return null.

- retailer: the retailer's name (e.g. "Origin", "AGL", "Red Energy")
- distributor: the network / distributor if shown (e.g. "Essential Energy", "Ausgrid", "Endeavour Energy", "Energex")
- nmi: the National Meter Identifier, 10 or 11 characters, as printed
- supply_address: the supply address as printed
- customer_name: the account holder's name as printed
- billing_period_start, billing_period_end: as YYYY-MM-DD
- billing_days: the number of days in the billing period
- total_kwh: the total electricity used in the period in kWh (all usage tariffs added, including controlled load, excluding any solar export)
- daily_average_kwh: the average daily use the bill prints, if it prints one
- peak_kwh, shoulder_kwh, off_peak_kwh: the kWh per time-of-use band when the bill splits them (null on a flat tariff)
- controlled_load_kwh: kWh on a controlled load / hot water tariff, if shown
- solar_export_kwh: kWh exported to the grid (solar feed-in) in the period, if shown
- feed_in_c_per_kwh: the feed-in tariff in cents per kWh, if shown
- usage_rate_c_per_kwh: the main usage rate in cents per kWh (inc GST if the bill shows inc GST figures; on a time-of-use tariff the peak rate), and
- usage_rates: an object of every usage rate shown, e.g. {"peak": 48.2, "shoulder": 30.1, "off_peak": 22.5, "controlled_load": 20.0}
- tou_hours: when the bill prints the time-of-use windows, an object of the hours each band applies, as 24 hour ranges, e.g. {"peak": "17:00-20:00", "shoulder": "07:00-17:00, 20:00-22:00", "off_peak": "22:00-07:00"}; leave a band out when the bill has no such band (a peak and off-peak only tariff has no shoulder); null when no hours are printed
- supply_charge_c_per_day: the daily supply charge in cents per day
- bill_total: the total amount of this bill in dollars (the amount due for this period, not the account balance carried forward)
- usage_charges_total: the dollars charged for usage in the period, if shown separately
- phases: "single" or "three" only when the bill makes it clear (for example a three-phase meter or three meter registers with the same tariff), otherwise null
- tariff_type: "flat", "time_of_use", "demand" or null
- same_period_last_year_kwh: last year's use for the same period if the bill compares it
- notes: one short sentence on anything a solar installer should know from this bill (e.g. existing solar export, a demand tariff, a very high controlled load), or null

Return only the JSON object, no commentary and no markdown fence.`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requirePricingRole(event);
  if (!auth) return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };

  try {
    const { projectId } = JSON.parse(event.body || '{}');
    if (!projectId) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'projectId is required' }) };
    const { supabaseAdmin, user } = auth;

    const [{ data: project, error: projErr }, { data: docs, error: docErr }] = await Promise.all([
      supabaseAdmin.from('projects').select('id, quote_number, proposal_template, template_answers, stc_zone_rating').eq('id', projectId).single(),
      supabaseAdmin.from('project_documents').select('id, file_path, file_name, mime_type').eq('project_id', projectId).eq('folder', BILL_FOLDER).order('created_at'),
    ]);
    if (projErr || !project) throw projErr || new Error('Quote not found');
    if (docErr) throw docErr;
    if (!docs || !docs.length) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Add the bill pages first (photos or a PDF).' }) };

    const blocks = [];
    const skipped = [];
    for (const doc of docs.slice(0, MAX_PAGES)) {
      const mediaType = mimeFor(doc.file_path, doc.mime_type);
      if (!mediaType) { skipped.push(doc.file_name); continue; }
      const { data, error } = await supabaseAdmin.storage.from('project-documents').download(doc.file_path);
      if (error || !data) { skipped.push(doc.file_name); continue; }
      const base64 = Buffer.from(await data.arrayBuffer()).toString('base64');
      blocks.push(mediaType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } }
        : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
    }
    if (!blocks.length) return { statusCode: 400, body: JSON.stringify({ ok: false, error: `None of the bill pages could be read (${skipped.join(', ')}). Use photos (JPG, PNG) or a PDF.` }) };

    const apiKey = await getIntegrationKey('anthropic');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text: PROMPT }] }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API error: ${res.status} ${text}`);
    }
    const data = await res.json();
    const raw = data.content.map((b) => b.text || '').join('').trim();
    const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let extracted;
    try { extracted = JSON.parse(cleaned); } catch (_) { throw new Error('The bill could not be read as a bill. Try clearer photos, one page each, or the PDF from the retailer.'); }
    if (!extracted || typeof extracted !== 'object') throw new Error('The bill could not be read.');

    const answers = project.template_answers || {};
    const zoneRating = Number(project.stc_zone_rating) || 1.382;
    const sizing = suggestSizes({ reading: extracted, answers, zoneRating });
    const metrics = billMetrics(extracted);
    if (!metrics.dailyKwh) {
      return { statusCode: 422, body: JSON.stringify({ ok: false, error: 'The pages were read but no usage in kWh was found on them. Add the page with the usage table (kWh and days) and try again.', reading: extracted }) };
    }

    const reading = {
      ...extracted,
      pages: blocks.length,
      skipped_files: skipped,
      read_at: new Date().toISOString(),
      read_by: user.id,
      sizing,
    };

    // Answers the bill can give, filled only where the question is still blank.
    const filled = {};
    const str = (v) => (v == null ? '' : String(v).trim());
    if (!str(answers.nmi) && str(extracted.nmi)) filled.nmi = str(extracted.nmi).slice(0, 11);
    if (!str(answers.daily_usage) && metrics.dailyKwh) filled.daily_usage = `${metrics.dailyKwh} kWh/day (bill, ${metrics.days || '?'} days)`;
    if (!str(answers.phases) && extracted.phases === 'three') filled.phases = 'Three phase';
    if (!str(answers.phases) && extracted.phases === 'single') filled.phases = 'Single phase';
    if (!str(answers.dnsp) && str(extracted.distributor)) {
      const d = str(extracted.distributor).toLowerCase();
      const pick = ['Essential Energy', 'Ausgrid', 'Endeavour Energy', 'Energex'].find(o => d.includes(o.toLowerCase().split(' ')[0]));
      filled.dnsp = pick || 'Other';
    }
    if (!str(answers.existing_system) && metrics.hasSolarAlready) filled.existing_system = 'Existing solar';
    const newAnswers = { ...answers, ...filled };

    const { error: upErr } = await supabaseAdmin.from('projects').update({ bill_reading: reading, template_answers: newAnswers }).eq('id', projectId);
    if (upErr) throw upErr;

    await supabaseAdmin.from('activity_log').insert({
      entity_type: 'project', entity_id: projectId, action: 'bill_read', changed_by: user.id,
      description: `AI read the electricity bill (${blocks.length} file${blocks.length === 1 ? '' : 's'}): ${metrics.dailyKwh} kWh a day${metrics.annualBill ? `, about $${metrics.annualBill} a year` : ''}${sizing.solarKw ? `, suggests ${sizing.solarKw} kW solar` : ''}${sizing.batteryKwh ? ` and ${sizing.batteryKwh} kWh battery` : ''}`,
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, reading, filled, answers: newAnswers, usage: data.usage || {} }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
