const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { requirePricingRole } = require('./_shared/require-pricing-role');

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

  // Pricing roles only: it spends the Anthropic key and reads private job documents.
  const auth = await requirePricingRole(event);
  if (!auth) return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };

  try {
    const { projectName, brief = '', stageNames = [], stageDescriptions = {}, documentPaths = [], style = 'story', template = '', templateAnswers = '', customerGets = '', withBattery = false } = JSON.parse(event.body);
    if (!brief && !templateAnswers) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'A project brief or the pre-quote answers are required' }) };
    }

    const apiKey = await getIntegrationKey('anthropic');
    const { supabaseAdmin } = auth;

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
Plain-English and direct - written for someone who isn't an electrician, explaining what's being installed and how it works. Not a sales pitch: no reassurance lines, no "peace of mind"/benefit-selling language, no padding sentences. Structure:
1. Open with one short paragraph stating what the system/job is and how it works end-to-end, in plain terms.
2. Then one section per major component or phase of the job, each with a short bolded heading naming that component (including its size/spec if relevant, e.g. "Solar Power System - 10kW"), followed by exactly one short paragraph: what it is and how it fits into the system. Skip anything not relevant to this particular job.
3. Close with a short bulleted list of what's included overall - no wrap-up paragraph.
No numbered sections, no formal Exclusions clause, no standards citations, no legalistic language. Direct and informative - explains what's happening and why it's built that way, without over-explaining or dressing it up.`;

    // An estimate is invoiced from actual hours and materials, so what is NOT covered matters as much as what is.
    // Estimates always list both, whatever house style was picked (this overrides the story style's "no exclusions").
    const estimateRule = template === 'quick_estimate' ? `
THIS DOCUMENT IS AN ESTIMATE. Whatever the style above says, it must clearly list BOTH what is included AND what is excluded:
- A heading line "Inclusions" followed by a bulleted list (each bullet starting with "- ") of everything the estimate covers.
- A heading line "Exclusions" followed by a bulleted list (each bullet starting with "- ") of what the estimate does NOT cover: anything specific to this job that a client might reasonably assume is included but is not (for example making good plaster or paint, non-electrical trades, permits and fees, switchboard or wiring faults found once work starts, extra work that is not listed), plus "any works not specifically listed above".
- Put "Exclusions" after "Inclusions". Do not leave either list out.
` : '';

    // Battery jobs (a Battery proposal, or Solar with Batteries as well): what the client must be
    // told and what the installer must get right. Sources: docs/BATTERY_QUOTE_COMPLIANCE_REQUIREMENTS.md.
    const batteryRule = (withBattery || template === 'battery') ? `
BATTERY: this job includes a home battery. The scope must cover, in plain words: the battery's usable capacity in kWh and the make and model where given; which circuits are backed up in a blackout (and that the rest are not); where the battery is mounted and that the location meets AS/NZS 5139 (not in a habitable room, clear of exits, with the required clearances and signage); whether it is a hybrid (DC coupled) or AC coupled system; that the battery is VPP capable and registered for monitoring; the network (DNSP) connection application; commissioning and a demonstration of the backup; and that the federal Cheaper Home Batteries discount (shown as an STC credit on the price) depends on the battery being on the CEC approved list, 5 to 100 kWh usable (the discount covers the first 50 kWh), designed and installed by an installer accredited with Solar Accreditation Australia for grid connected battery systems, the first claim at the address and the solar being commissioned before or with it. State these as what is being done, not as a legal lecture.
` : '';

    const typeLine = { solar: 'a grid-connected solar PV system', battery: 'a home battery storage system', renovation: 'a renovation', service_work: 'service work', quick_estimate: 'an estimate', new_build: 'a new build' }[template] || 'electrical work';
    const promptText = `You are writing a scope-of-works document for an electrical contractor's client-facing quote.

Project: ${projectName || 'This project'}
Type of job: ${typeLine}${withBattery && template !== 'battery' ? ' with a battery as well' : ''}
Brief from the contractor: ${brief || '(none typed, use the pre-quote answers below)'}
${customerGets ? `\nWhat the customer is getting (from the design and the stages):\n${customerGets}\n` : ''}${templateAnswers ? `\nPre-quote information gathered from the client (internal notes: use them so the scope fits this site, never list them back as a questionnaire, and leave out anything the client would not expect to see, such as medical equipment or access codes):\n${templateAnswers}\n` : ''}
Stages in this quote:
${stageList}
${batteryRule}
${docBlocks.length ? 'Reference any attached plans, drawings, or electricity bills where relevant to ground the scope in what they actually show (e.g. existing switchboard capacity, circuit count, meter details).' : ''}

${styleGuide}
${estimateRule}
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
        model: 'claude-sonnet-5-5',
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
