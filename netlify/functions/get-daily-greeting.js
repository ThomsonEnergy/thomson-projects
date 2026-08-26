const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { getAdminClient } = require('./_shared/require-admin');

// One AI-generated greeting per calendar day, shared across every user and
// cached in the daily_greetings table - so the homepage changes daily like
// Claude's own greeting does, without an AI call on every single page load.
// The message contains a literal "{name}" token that the homepage swaps
// for the logged-in person's first name client-side.
exports.handler = async () => {
  try {
    // Sydney time, not server UTC - an Australian trade business shouldn't
    // see "today's" greeting flip over mid-afternoon local time.
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

    const supabaseAdmin = getAdminClient();

    const { data: existing } = await supabaseAdmin
      .from('daily_greetings')
      .select('message')
      .eq('greeting_date', todayStr)
      .maybeSingle();
    if (existing) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, message: existing.message }) };
    }

    const apiKey = await getIntegrationKey('anthropic');
    const prompt = `Write one short, high-energy greeting for the home screen of an internal app used by staff at an electrical contracting company (office staff and tradespeople on the tools). The goal is to genuinely get people fired up and motivated for the day ahead - punchy, confident, a bit of swagger, like a coach hyping up the crew before a shift, not a bland corporate "welcome back". Plain trade language, no marketing fluff, no emoji, one sentence only, exclamation marks are fine. Vary the angle day to day - sometimes about getting the tools out, smashing the job list, being the best crew in the game, finishing strong, etc. Include the literal token {name} exactly once, where the person's first name should go (e.g. "Let's get out there and smash it today, {name}!"). Respond with ONLY the sentence, no quotes, no other text.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API error: ${res.status} ${text}`);
    }

    const data = await res.json();
    let message = data.content.map((b) => b.text || '').join('').trim().replace(/^"|"$/g, '');
    if (!message.includes('{name}')) message = `{name}, ${message.charAt(0).toLowerCase()}${message.slice(1)}`;

    // Two people loading the homepage for the first time today could race
    // here - ignore a unique-violation on insert and just read back
    // whichever row won, rather than erroring.
    const { error: insertErr } = await supabaseAdmin
      .from('daily_greetings')
      .insert({ greeting_date: todayStr, message });

    if (insertErr) {
      const { data: winner } = await supabaseAdmin
        .from('daily_greetings')
        .select('message')
        .eq('greeting_date', todayStr)
        .maybeSingle();
      if (winner) return { statusCode: 200, body: JSON.stringify({ ok: true, message: winner.message }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, message }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
