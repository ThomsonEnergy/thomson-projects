const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { requirePricingRole } = require('./_shared/require-pricing-role');
const { claudeJson } = require('./_shared/claude-json');

// Uses your Anthropic API key (set in Settings > API Keys, falls back to the
// ANTHROPIC_API_KEY environment variable if that hasn't been set yet) to
// draft a professional scope-of-works description for each stage, based on
// a short brief you type in. Also suggests a fitting name for each stage,
// rather than requiring the existing placeholder names to stay as-is.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Pricing roles only: it spends the Anthropic key.
  if (!(await requirePricingRole(event))) return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };

  try {
    const { projectName, brief = '', stageNames, templateAnswers = '', customerGets = '', template = '', withBattery = false } = JSON.parse(event.body);
    if ((!brief && !templateAnswers) || !Array.isArray(stageNames) || stageNames.length === 0) {
      return { statusCode: 400, body: 'brief (or pre-quote answers) and stageNames are required' };
    }

    const apiKey = await getIntegrationKey('anthropic');

    const typeLine = { solar: 'a grid-connected solar PV system', battery: 'a home battery storage system', renovation: 'a renovation', service_work: 'service work', quick_estimate: 'an estimate', new_build: 'a new build' }[template] || 'electrical work';
    const prompt = `You are writing scope-of-works descriptions for an electrical contractor's client-facing quote.

Project: ${projectName}
Type of job: ${typeLine}${withBattery && template !== 'battery' ? ' with a battery as well' : ''}
Brief from the contractor: ${brief || '(none typed, use the pre-quote answers below)'}
${customerGets ? `\nWhat the customer is getting (from the design and the stages):\n${customerGets}\n` : ''}${templateAnswers ? `\nPre-quote information gathered from the client (internal, do not repeat verbatim, use it to make the stages fit the site):\n${templateAnswers}\n` : ''}
The quote currently has ${stageNames.length} stage(s), placeholder-named: ${stageNames.join(', ')}.

For each stage, suggest a short, fitting stage name (2-4 words, plain trade language - e.g. "Site Power", "Switchboard Upgrade", "Panel Install") that matches what's actually being described in the brief, rather than keeping a generic placeholder name that may not suit this particular job. Then write a short scope-of-works description (1 to 2 sentences, plain trade language, no marketing fluff) for that stage.

Keep the same number of stages (${stageNames.length}) and the same overall order/intent as the placeholders - you're renaming and describing them to fit the brief, not adding or removing stages.

Respond with ONLY a JSON array, no other text, no markdown fences, one object per stage in order. Example shape:
[{"name": "Site Power", "description": "..."}, {"name": "Rough In", "description": "..."}]`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: claudeJson({
        model: 'claude-sonnet-5-5',
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
    const stages = JSON.parse(cleaned);

    if (!Array.isArray(stages) || stages.length !== stageNames.length) {
      throw new Error('AI response did not match the expected number of stages - try again.');
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, stages }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
