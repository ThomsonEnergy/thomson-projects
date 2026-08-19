const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');

// Uses your Anthropic API key (set in Settings > API Keys, falls back to the
// ANTHROPIC_API_KEY environment variable if that hasn't been set yet) to
// draft a professional scope-of-works description for each stage, based on
// a short brief you type in.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { projectName, brief, stageNames } = JSON.parse(event.body);
    if (!brief || !Array.isArray(stageNames) || stageNames.length === 0) {
      return { statusCode: 400, body: 'brief and stageNames are required' };
    }

    const apiKey = await getIntegrationKey('anthropic');

    const prompt = `You are writing scope-of-works descriptions for an electrical contractor's client-facing quote.

Project: ${projectName}
Brief from the contractor: ${brief}

Write a short scope-of-works description (1 to 2 sentences, plain trade language, no marketing fluff) for each of these stages: ${stageNames.join(', ')}.

Respond with ONLY a JSON object, no other text, no markdown fences, mapping each exact stage name to its description. Example shape:
{"Site Power": "...", "Rough In": "..."}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API error: ${res.status} ${text}`);
    }

    const data = await res.json();
    const raw = data.content.map((b) => b.text || '').join('').trim();
    const cleaned = raw.replace(/^```json/i, '').replace(/```$/, '').trim();
    const descriptions = JSON.parse(cleaned);

    return { statusCode: 200, body: JSON.stringify({ ok: true, descriptions }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
