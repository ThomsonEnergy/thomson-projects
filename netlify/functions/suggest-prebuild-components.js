// POST /.netlify/functions/suggest-prebuild-components
// Body: { name, description, category, subcategory }
// Pricing roles only (spends the Anthropic key). Guesses the labour and material components a
// prebuild needs from its name and client description, matched against the Stock list so a
// known part comes back with its Stock cost. Suggestions only: the form shows them tagged
// "AI suggested, check" and nothing is saved until a person confirms and presses Save.
// Never invents prices: an unmatched part comes back with no cost (Needs a price).

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { requirePricingRole } = require('./_shared/require-pricing-role');

const MAX_MATERIALS = 400;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };

  try {
    const { name = '', description = '', category = '', subcategory = '' } = JSON.parse(event.body || '{}');
    if (!name.trim() && !description.trim()) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Give the prebuild a name or a description first' }) };
    }
    const { supabaseAdmin } = auth;
    const { data: materials, error: matErr } = await supabaseAdmin
      .from('materials').select('id, name, category, cost_price').order('name').limit(MAX_MATERIALS);
    if (matErr) throw matErr;

    const apiKey = await getIntegrationKey('anthropic');
    const stockList = (materials || []).map((m, i) => `${i + 1}. ${m.name}${m.category ? ` [${m.category}]` : ''}`).join('\n') || '(Stock is empty)';

    const prompt = `You are helping an Australian electrical and solar contractor build a "prebuild": a reusable supply-and-install package priced from its parts (materials from Stock plus labour hours).

Prebuild name: ${name}
Category: ${category}${subcategory ? ' / ' + subcategory : ''}
Client-facing description: ${description || '(none yet)'}

Stock list (number. name [category]):
${stockList}

List the components this prebuild needs for ONE unit of the package, as a tradesperson would price it:
- materials: the parts and consumables (cable by the metre, conduit, fittings, fixings, terminations, labels). Where a Stock item is the right part, use it: set "stock" to its number from the list and copy its name exactly. Where nothing in Stock fits, set "stock" to null and write a plain description.
- labour: one or two lines with hours (for example "Electrician" 2.5 hours, "Apprentice" 2 hours), "stock" null.
Quantities are numbers (metres, each, hours). Be realistic, not generous. 4 to 14 components.

Respond with ONLY a JSON array, no other text, no markdown fences:
[{"item_type": "material" | "labour", "description": "...", "quantity": 1, "stock": 12 | null}]`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text().catch(() => '')}`);
    const data = await res.json();
    const raw = data.content.map((b) => b.text || '').join('').trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('The AI did not return a list. Try again.');

    const components = parsed.slice(0, 20).map((c) => {
      const itemType = c.item_type === 'labour' ? 'labour' : 'material';
      const idx = Number(c.stock);
      const match = itemType === 'material' && idx >= 1 && idx <= (materials || []).length ? materials[idx - 1] : null;
      return {
        item_type: itemType,
        description: match ? match.name : String(c.description || '').trim(),
        quantity: Math.max(0, Number(c.quantity) || 1),
        unit_cost: match ? Number(match.cost_price) || 0 : null, // null = Needs a price (never invented)
        material_id: match ? match.id : null,
        matched: !!match,
      };
    }).filter((c) => c.description);

    return { statusCode: 200, body: JSON.stringify({ ok: true, components }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
