// Shared by generate-solar-tasks.js (the client-facing endpoint used from
// the quote page) and create-default-job-tasks.js (called server-side at
// job creation, no HTTP round-trip needed since it already runs inside a
// Netlify function with admin access) - both need the exact same "turn a
// missing compliance item into one specific, well-worded task" step, so
// it lives here once rather than being duplicated or called over HTTP
// from one function to another.
//
// See generate-solar-tasks.js for the fuller explanation of why this only
// rewords already-correct, already-required items rather than deciding
// what's required itself.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');

async function wordSolarTasks({ missing, equipment = {} }) {
  if (!Array.isArray(missing) || !missing.length) return [];

  const apiKey = await getIntegrationKey('anthropic');

  const equipmentList = ['panels', 'inverters', 'batteries']
    .flatMap((k) => (equipment[k] || []).map((e) => `- ${e.description || JSON.stringify(e)}`))
    .join('\n') || '(no equipment pulled from Pylon yet)';

  const missingList = missing.map((m) => `- [${m.id}] ${m.label}`).join('\n');

  const prompt = `You are turning a compliance checklist into specific, actionable task descriptions for a solar installer's project manager.

Equipment specified in Pylon for this job:
${equipmentList}

Missing/outstanding checklist items (each already correct and required - your job is only to phrase each as one short, specific task, not to change what's required):
${missingList}

For each missing item, write one short task description (plain language, one sentence, under 15 words where possible). Where an item is about equipment (ordering, serial numbers, model confirmation), name the actual panel/inverter/battery from the list above instead of saying "the equipment" or "gear" generically. Keep the same order and the same [id] for each.

Respond with ONLY a JSON array, no other text, no markdown fences. One object per input item, same order:
[{"id": "the same id from the input", "description": "the task text"}]`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1000,
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
  const worded = JSON.parse(cleaned);

  const byId = {};
  (Array.isArray(worded) ? worded : []).forEach((w) => { if (w && w.id) byId[w.id] = w.description; });
  return missing.map((m) => ({ id: m.id, description: byId[m.id] || m.label }));
}

module.exports = { wordSolarTasks };
