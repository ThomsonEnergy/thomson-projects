const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { getAdminClient } = require('./_shared/require-admin');

// Drafts a full scope-of-works document from a brief, the stage names/
// descriptions already generated, and optionally the actual content of
// uploaded plans or electricity bills — pulled from the private
// project-documents bucket so the client never has to send large files
// through the browser twice.

const MAX_DOCS = 5;

function mimeFor(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { projectName, brief, stageNames = [], stageDescriptions = {}, documentPaths = [] } = JSON.parse(event.body);
    if (!brief) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'A project brief is required' }) };
    }

    const apiKey = await getIntegrationKey('anthropic');
    const supabaseAdmin = getAdminClient();

    const docBlocks = [];
    for (const path of documentPaths.slice(0, MAX_DOCS)) {
      const mediaType = mimeFor(path);
      if (!mediaType) continue; // skip anything we don't know how to hand to the model

      const { data, error } = await supabaseAdmin.storage.from('project-documents').download(path);
      if (error || !data) continue; // best-effort — one bad file shouldn't block the whole draft

      const buffer = Buffer.from(await data.arrayBuffer());
      const base64 = buffer.toString('base64');

      docBlocks.push(
        mediaType === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } }
          : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }
      );
    }

    const stageList = stageNames.map(n => `- ${n}${stageDescriptions[n] ? ': ' + stageDescriptions[n] : ''}`).join('\n');

    const promptText = `You are writing a scope-of-works document for an electrical contractor's client-facing quote.

Project: ${projectName || 'This project'}
Brief from the contractor: ${brief}

Stages in this quote:
${stageList}

${docBlocks.length ? 'Reference any attached plans, drawings, or electricity bills where relevant to ground the scope in what they actually show (e.g. existing switchboard capacity, circuit count, meter details).' : ''}

Write a clear, professional scope-of-works document (plain text, a few short paragraphs and/or a bulleted list where that reads better — no markdown headers, no marketing language). It should read like something a licensed electrician wrote for a client to sign off on, covering what's included stage by stage. Do not include pricing.`;

    const content = [{ type: 'text', text: promptText }, ...docBlocks];

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
        messages: [{ role: 'user', content }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API error: ${res.status} ${text}`);
    }

    const data = await res.json();
    const sow = data.content.map((b) => b.text || '').join('').trim();

    return { statusCode: 200, body: JSON.stringify({ ok: true, sow }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
