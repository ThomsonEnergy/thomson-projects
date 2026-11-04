// Reads a photo of a part's label (on the box, the bag or the item itself) with Claude and returns
// what is printed on it: the barcode digits, the part number, brand, a short name and the pack size.
// Used by read-part-label.js (the Scan a part button on the Stock page, a vehicle page and the
// clock-out stock panel, js/stock-scan.js). Reading only: nothing is saved here.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');
const { claudeJson } = require('./claude-json');

const PROMPT = `This is a photo of an electrical or solar part, or its box, bag or label, taken by an electrician who wants to add it to the company's stock list. Read what is printed and return a JSON object with:

- barcode: the digits printed under or beside the barcode (EAN-13, UPC or similar), digits only, null if no barcode is visible or the digits cannot be read
- part_number: the manufacturer's part number, product code or catalogue number (for example 56C320, 2031VA, MX-Q20), the most specific code on the label; null if none
- brand: the manufacturer or brand (Clipsal, Hager, NHP, Enphase, Olex...), null if not shown
- name: a short plain name for the stock list, brand first, as an electrician would say it, for example "Clipsal 56C320 20A 3 phase switched socket" or "Olex 2.5mm twin and earth 100m"; use the label's own description when it has one
- description: the full description printed on the label, if any
- pack_quantity: how many are in the pack if the label says (for example 100 in a bag of saddles), as a number, else null
- category: one of "Cable", "Switchgear", "Accessories", "Lighting", "Solar", "Conduit and fixings", "Consumables", "Other"
- confidence: "high" when the part number or barcode is clearly readable, "low" when you had to guess

Read exactly what is printed; never invent a part number or barcode. If the photo is not of a part or label at all, return {"not_a_part": true}. Respond with ONLY the JSON object, no other text and no markdown fences.`;

async function readPartLabel({ fileBase64, mediaType }) {
  const apiKey = await getIntegrationKey('anthropic');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: claudeJson({
      model: 'claude-sonnet-5-5',
      max_tokens: 600,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } }, { type: 'text', text: PROMPT }] }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API error: ${res.status} ${text}`);
  }
  const data = await res.json();
  const raw = data.content.map((b) => b.text || '').join('').trim();
  const parsed = JSON.parse(raw.replace(/^```json/i, '').replace(/```$/, '').trim());
  const clean = (v) => (v == null ? null : String(v).trim() || null);
  return {
    not_a_part: !!parsed.not_a_part,
    barcode: clean(parsed.barcode)?.replace(/\D/g, '') || null,
    part_number: clean(parsed.part_number),
    brand: clean(parsed.brand),
    name: clean(parsed.name),
    description: clean(parsed.description),
    pack_quantity: Number(parsed.pack_quantity) > 0 ? Number(parsed.pack_quantity) : null,
    category: clean(parsed.category),
    confidence: parsed.confidence === 'high' ? 'high' : 'low',
    usage: data.usage || {},
  };
}

module.exports = { readPartLabel };
