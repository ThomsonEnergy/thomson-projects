const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');

// Turns a lead's raw source + details JSON (see WEBSITE_LEAD_CAPTURE.md
// for the shape each source sends) into a short, plain-English "what
// does this person actually want" description for the Leads page - so
// staff can triage at a glance instead of reading raw JSON. Distinct from
// generate-installer-summary.js (condenses an existing scope of works);
// this is writing a summary from scratch out of structured form data.

const SOURCE_LABELS = { enquiry_modal: 'General enquiry form', calculator: 'Solar calculator', package: 'Package click', brand: 'Brand click' };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { source, details, name } = JSON.parse(event.body || '{}');

    const apiKey = await getIntegrationKey('anthropic');

    const detailsText = details && Object.keys(details).length
      ? Object.entries(details).filter(([k]) => k !== 'attachments').map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')
      : '(no further details captured)';
    const hasAttachments = !!(details && details.attachments && details.attachments.length);

    const prompt = `You're writing two things for an electrical/solar contractor's office staff, so they can tell at a glance what a website enquiry actually wants before deciding whether to turn it into a job or a quote.

Enquiry type: ${SOURCE_LABELS[source] || source}
Name: ${name || '(not given)'}
Captured form data:
${detailsText}
${hasAttachments ? 'They also attached a file (e.g. a switchboard photo or power bill).' : ''}

Reply with EXACTLY two lines, nothing else:
TITLE: a 3-6 word label for what this is, e.g. "Switchboard upgrade" or "Solar + battery enquiry" - this is used to NAME the job/quote created from it, so keep it short and concrete, not a sentence.
SUMMARY: a one-to-two sentence plain-English description of what they want. Plain, direct, staff-facing language (not a marketing tone). If it's urgent/reactive-sounding work (a fault, a repair, something broken), say so plainly - office staff use this to decide whether it needs a quote or can just become a job straight away. If there isn't much to go on, just say that plainly rather than padding it out.

No other text, no markdown, exactly those two lines.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic API error: ${res.status} ${errText}`);
    }
    const data = await res.json();
    const raw = data.content.map((b) => b.text || '').join('').trim();
    const titleMatch = raw.match(/^TITLE:\s*(.+)$/m);
    const summaryMatch = raw.match(/^SUMMARY:\s*([\s\S]+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : null;
    const summary = summaryMatch ? summaryMatch[1].trim() : raw;

    return { statusCode: 200, body: JSON.stringify({ ok: true, title, summary }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
