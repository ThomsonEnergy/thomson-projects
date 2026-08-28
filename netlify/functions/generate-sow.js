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
    const { projectName, brief, stageNames = [], stageDescriptions = {}, documentPaths = [], style = 'story' } = JSON.parse(event.body);
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

    // Two house styles, picked by whoever's building the quote - matched
    // to two real past SOWs the business was happy with, extracted down
    // to the pattern (not their specific job content) so new ones follow
    // the same shape without repeating someone else's job details.
    const styleGuide = style === 'structured' ? `STYLE: Structured & numbered - for commercial builders/developers.
Formal and precise, written for a professional reading it alongside a contract. Structure:
1. Open with one short paragraph stating what the scope covers overall - no marketing language, just what's being done and why (e.g. a make-safe followed by reconnection, or a full system install).
2. Break the work into numbered sub-sections by discipline/phase, each with its own short heading and a bulleted list underneath - e.g. "Supply of Equipment", "Installation Works", "Electrical Works", "Network & Regulatory Applications" (only if relevant - DNSP applications, STC/battery rebate lodgement), "Testing & Commissioning", "Compliance & Documentation". Not every job needs every section - use only the ones relevant to the stages given. For a small/simple job, a single "Inclusions" bulleted list is enough instead of multiple numbered sub-sections.
3. Cite the specific relevant AS/NZS standard where it's natural to (e.g. AS/NZS 3000, AS/NZS 5033 for solar DC wiring, AS/NZS 4777.2 for inverter commissioning) - only where genuinely applicable, don't force it.
4. Always end with an "Exclusions" section (bulleted) - job-specific exclusions plus standard ones like "any works not specifically listed above" and non-electrical trade work (building, plumbing, etc.), and note that anything excluded found necessary once work starts is treated as a variation requiring written client approval before proceeding (except genuine safety work).
5. If the brief or attached documents mention something site-specific worth flagging (an existing defect, an access constraint, a condition that could turn into extra chargeable work) - add a short "Site-Specific Notes" section describing it factually, and only add a recommendation/next-step section if it's the kind of issue that genuinely warrants one (e.g. a roof condition affecting a 25+ year installation). Don't invent a site issue that isn't actually implied by the brief/documents.
Bullet points are short phrases starting with a gerund or plain verb (Disconnection of..., Supply and installation of..., Testing of...), not full sentences with lots of padding.` : `STYLE: Story-flowing - for residential homeowners.
Warm, plain-English, and educational - written for someone who isn't an electrician and wants to understand what they're buying and why it's a good choice, not just a checklist of tasks. Structure:
1. Open with one short paragraph introducing what the system/job is and why this approach/equipment is a solid choice (e.g. reliability, how common/proven it is) - light reassurance, not a hard sell.
2. A second short paragraph on how the system actually works end-to-end, in plain terms.
3. Then one section per major component or phase of the job, each with a short bolded heading naming that component (including its size/spec if relevant, e.g. "Solar Power System - 10kW"), followed by one or two short paragraphs: what it is, how it fits into the whole system, and the tangible benefit to the homeowner day-to-day. Skip anything not relevant to this particular job.
4. Close with a short "complete solution" wrap-up paragraph, then a short numbered list of the key benefits/highlights of the finished system.
No numbered sections, no formal Exclusions clause, no standards citations, no legalistic language - this reads like a knowledgeable tradesperson explaining things to a friend, not a contract.`;

    const promptText = `You are writing a scope-of-works document for an electrical contractor's client-facing quote.

Project: ${projectName || 'This project'}
Brief from the contractor: ${brief}

Stages in this quote:
${stageList}

${docBlocks.length ? 'Reference any attached plans, drawings, or electricity bills where relevant to ground the scope in what they actually show (e.g. existing switchboard capacity, circuit count, meter details).' : ''}

${styleGuide}

Write the scope of works now (plain text - no markdown headers/asterisks, use plain numbering or a heading line where the style calls for it). Do not include pricing.`;

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
