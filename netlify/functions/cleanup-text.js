const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');

// Shared "clean this up" pass for any AI-generated text a staff member has
// since hand-edited (added, removed, or reworded parts of an AI draft, or
// written some of it themselves). Rewrites for wording/grammar/formatting
// only - the instructions passed in tell it what format/tone to land on,
// but it must never drop or invent scope, since the point is polishing an
// edit, not regenerating a fresh draft from scratch.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { text, instructions } = JSON.parse(event.body || '{}');
    if (!text || !text.trim()) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Nothing to clean up yet.' }) };
    }

    const apiKey = await getIntegrationKey('anthropic');

    const prompt = `A staff member at an Australian electrical/solar contractor has been editing a piece of text - it may have started as an AI draft, but they've since added things, removed things, or reworded parts of it by hand. Clean it up: fix grammar, wording, and formatting so it reads consistently, WITHOUT changing what it actually says. Keep every fact, instruction, and edit they made. Do not remove content, do not invent new content, and do not revert it back toward some earlier draft you don't have - you only have what's below, treat it as final in substance and just polish the writing and formatting.

${instructions ? instructions + '\n\n' : ''}Text to clean up:
${text}

Respond with ONLY the cleaned-up text - no commentary, no markdown fences, no quotation marks around it.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic API error: ${res.status} ${errText}`);
    }

    const data = await res.json();
    const cleaned = data.content.map((b) => b.text || '').join('').trim();

    return { statusCode: 200, body: JSON.stringify({ ok: true, text: cleaned }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
