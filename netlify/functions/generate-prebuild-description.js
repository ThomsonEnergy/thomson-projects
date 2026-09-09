const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');

// Drafts a prebuild's client-facing description in the house format: an
// ALL CAPS "SUPPLY AND INSTALL NEW ..." title line, then a short trade-
// language paragraph closing with the relevant AS/NZS standard(s). Given
// the prebuild's name and its actual components (not just the name alone)
// so the description reflects what's really in the package, not a generic
// guess - e.g. a prebuild with battery/DC materials should reference
// AS/NZS 5033/5139, not just the general AS/NZS 3000 wiring rules.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { name, components } = JSON.parse(event.body || '{}');
    if (!name) {
      return { statusCode: 400, body: JSON.stringify({ error: 'name is required' }) };
    }

    const apiKey = await getIntegrationKey('anthropic');

    const componentLines = (components || [])
      .filter((c) => c.description)
      .map((c) => `- ${c.item_type === 'labour' ? 'Labour' : 'Material'}: ${c.description}`)
      .join('\n') || '(no components listed yet)';

    const prompt = `You are writing the client-facing description for a "prebuild" - a reusable supply-and-install package - for an Australian electrical/solar contractor's quoting system. This is what the CLIENT sees on their quote; it should read as a professional trade scope, not sales copy.

Prebuild name: ${name}
Components:
${componentLines}

Format (follow exactly):
Line 1: a short title in ALL CAPS, starting with "SUPPLY AND INSTALL NEW" followed by the item.
Then a blank line, then one paragraph (2-4 sentences) in plain trade language closing with a compliance reference to the relevant Australian Standard(s). Use AS/NZS 3000 for general electrical work and AS/NZS 3008 for cable sizing where relevant; only reference AS/NZS 5033 and AS/NZS 5139 if the components indicate solar panel or battery/DC work specifically - don't add them to an unrelated general electrical item.

Two important rules:
1. Describe ONLY the scope the components above actually cover - don't assume or add steps that aren't represented there. Many jobs are broken into separate prebuilds (e.g. running cable to a location is its own prebuild, separate from terminating it and fitting a device). If there is no cable/wiring-run material or labour component listed, do NOT say the work involves running, laying, or pulling cable - describe it as connecting/terminating to the EXISTING circuit or cabling instead, since a new cable run is out of scope for that prebuild.
2. Never attribute the work to a specific qualification level (e.g. "licensed electrician", "licensed electrical specialist") - apprentices and other staff do this work too, under supervision as required. Describe the work itself, not who's doing it.

Two examples of the exact tone and format wanted:

SUPPLY AND INSTALL NEW DC BATTERY CABLE

Supply and installation of DC battery cabling (positive + negative) enclosed in conduit, run and fixed to building structure, compliant with AS/NZS 5139, AS/NZS 5033, AS/NZS 3000 and sized to AS/NZS 3008.

---

(This second example is for a fitting-only prebuild - components were just "Material: LED downlight fitting" and generic labour, no cable component, so note there is no mention of running cable, only connecting to what's already there:)

SUPPLY AND INSTALL NEW 90MM DOWNLIGHT

Supply and installation of a 90mm LED downlight fitting - cut the ceiling aperture, connect and terminate to the existing circuit, and fit the downlight in place, in accordance with AS/NZS 3000.

Respond with ONLY the description text (title line, blank line, paragraph) - no other commentary, no markdown fences, no quotation marks around it.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API error: ${res.status} ${text}`);
    }

    const data = await res.json();
    const description = data.content.map((b) => b.text || '').join('').trim();

    return { statusCode: 200, body: JSON.stringify({ ok: true, description }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
