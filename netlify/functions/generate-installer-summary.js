const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');

// Cooper's suggestion (Bugs & Updates board, "Installer job card quote
// summary"): once a quote's scope of works is written, the installer on
// site shouldn't have to read the whole prose document - a short, plain
// inclusions/exclusions punch list is what they actually need. Distinct
// from generate-sow.js (writes the client-facing document from scratch) -
// this reads an EXISTING scope of works and condenses it, staff-facing not
// client-facing.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { projectName, sowText, stages = [] } = JSON.parse(event.body || '{}');
    if (!sowText || !sowText.trim()) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'This job has no scope of works to summarise yet.' }) };
    }

    const apiKey = await getIntegrationKey('anthropic');

    const stageList = stages.filter((s) => s.name).map((s) => `- ${s.name}${s.description ? ': ' + s.description : ''}`).join('\n');

    const prompt = `You're condensing a client-facing scope of works into a short on-site reference for the installer/tradesperson actually doing the job - not the client, not a sales document. They need to glance at this on their phone before/during the job and know exactly what's in scope and what isn't, without wading through the full document's formal language.

Job: ${projectName || 'This job'}

${stageList ? `Stages quoted:\n${stageList}\n\n` : ''}Full scope of works document:
${sowText}

Write a short summary, plain trade language, no marketing/reassurance filler, no repeating the standards citations verbatim (just note compliance requirements briefly if genuinely important on site). Format:

INCLUDED
- short bullet points, grouped by stage/area if the job has multiple stages, otherwise just a flat list

NOT INCLUDED / EXCLUDED
- anything the document explicitly excludes or that a reasonable installer might otherwise assume is included but isn't - skip this section if the document doesn't mention any exclusions

WATCH FOR
- only include this section if the document mentions a genuine site-specific note, constraint, or thing to double-check before starting (an access issue, an existing defect, a condition affecting the work) - omit entirely if there's nothing like that

Keep it tight - a busy tradesperson reading this on site, not a report. Plain text, no markdown headers/asterisks beyond the section labels above exactly as written.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic API error: ${res.status} ${errText}`);
    }
    const data = await res.json();
    const summary = data.content.map((b) => b.text || '').join('').trim();

    return { statusCode: 200, body: JSON.stringify({ ok: true, summary }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
