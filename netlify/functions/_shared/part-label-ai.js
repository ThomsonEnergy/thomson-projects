// Reads a photo of a part's label (on the box, the bag or the item itself) with Claude and returns
// what is printed on it: the barcode digits, the part number, brand, a short name, a category and
// what kind of thing it is (part, cable with the drum size, consumable with the pack, or a tool).
// Used by read-part-label.js (the Scan a part button on the Stock page, a vehicle page and the
// clock-out stock panel, js/stock-scan.js). Reading only: nothing is saved here.

const { callClaude } = require('./price-list-ai');

const prompt = (categories) => `This is a photo of an electrical or solar part, or its box, bag or label, taken by an electrician who wants to add it to the company's stock list. Read what is printed and return a JSON object with:

- barcode: the digits printed under or beside the barcode (EAN-13, UPC or similar), digits only, null if no barcode is visible or the digits cannot be read
- part_number: the manufacturer's part number, product code or catalogue number (for example 56C320, 2031VA, MX-Q20), the most specific code on the label; null if none
- brand: the manufacturer or brand (Clipsal, Hager, NHP, Enphase, Olex...), null if not shown
- name: a short plain name for the stock list, brand first, as an electrician would say it, for example "Clipsal 56C320 20A 3 phase switched socket" or "Olex 2.5mm twin and earth 100m"; use the label's own description when it has one
- description: the full description printed on the label, if any
- category: ${categories.length ? `one of the stock list's own categories if one fits (${categories.map(c => `"${c}"`).join(', ')}), else a short new one` : 'a short category such as "Cable", "Switchgear" or "Solar"'}
- kind: what kind of thing it is: "cable" (sold on a drum, coil, reel or roll and used by the metre: TPS, twin and earth, orange circular, data, solar DC, flex), "consumable" (used by the handful from a bag, box or pack: zip ties, saddles, screws, wall plugs, tape, glands, connectors), "tool" (a drill, driver, grinder, tester, multimeter, ladder, crimper or other tool), else "part" (a switch, socket, breaker, panel, inverter, light, anything counted one by one)
- pack_qty: for cable, the metres on a full drum as printed (100, 200, 500), a number; null for anything else or when not printed
- pack_label: for a consumable, the pack size as printed ("bag of 100", "box of 50", "pk 25"); null otherwise
- confidence: "high" when the part number or barcode is clearly readable, "low" when you had to guess

Read exactly what is printed; never invent a part number or barcode. If the photo is not of a part or label at all, return {"not_a_part": true}. Respond with ONLY the JSON object, no other text and no markdown fences.`;

// categories: the Stock list's existing categories, so a scanned item lands in one of them.
async function readPartLabel({ fileBase64, mediaType, categories = [] }) {
  const { raw, usage } = await callClaude([{ type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } }, { type: 'text', text: prompt(categories) }], 600);
  const parsed = JSON.parse(raw);
  const clean = (v) => (v == null ? null : String(v).trim() || null);
  return {
    not_a_part: !!parsed.not_a_part,
    barcode: clean(parsed.barcode)?.replace(/\D/g, '') || null,
    part_number: clean(parsed.part_number),
    brand: clean(parsed.brand),
    name: clean(parsed.name),
    description: clean(parsed.description),
    category: clean(parsed.category),
    kind: ['part', 'cable', 'consumable', 'tool'].includes(parsed.kind) ? parsed.kind : null,
    pack_qty: Number(parsed.pack_qty) > 0 ? Number(parsed.pack_qty) : null,
    pack_label: clean(parsed.pack_label),
    confidence: parsed.confidence === 'high' ? 'high' : 'low',
    usage,
  };
}

module.exports = { readPartLabel };
