// Runs the picture tagger's cases (cases.json) through the real reader
// (_shared/photo-tagger.js tagPhoto) and prints pass or fail per case.
//
//   ANTHROPIC_API_KEY=... node agents/evals/photo-tagger/run.js
//
// The key is the one in the api_keys table (Settings > API Keys); copy it into the environment
// for the run, never into the repo. The pictures are read from the live site by their link, so
// the run needs the internet. The code's own rules (cleanReading: what may be stored, and when a
// picture is fine for proposals) are checked first with no API call, so that part runs anywhere.
const path = require('path');
const { tagPhoto, cleanReading, jobEquipment, tagImageUrl, THINGS } = require(path.join(__dirname, '..', '..', '..', 'netlify', 'functions', '_shared', 'photo-tagger.js'));

const cases = require('./cases.json');
let failed = 0;
const say = (ok, id, detail) => { if (!ok) failed++; console.log(`${ok ? 'pass' : 'FAIL'}  ${id}${detail ? `  ${detail}` : ''}`); };

// 1. Code-only checks.
const good = { brands: ['Sigenergy'], things: ['inverter', 'battery'], models: ['SigenStor EC 15.0'], kind: 'finished install', caption: 'Inverter and battery on a wall', people: false, identifying: false, fine_for_proposals: true };
say(cleanReading(good).tags.join('|') === 'sigenergy|inverter|battery|sigenstor ec 15.0|finished install', 'clean: tags are lower case, in order, with the kind last');
say(cleanReading(good).okForProposals === true, 'clean: a tidy finished install is fine for proposals');
say(cleanReading({ ...good, people: true }).okForProposals === false, 'clean: a person in the picture is never fine for proposals');
say(cleanReading({ ...good, identifying: true }).okForProposals === false, 'clean: anything identifying is never fine for proposals');
say(cleanReading({ ...good, kind: 'in progress' }).okForProposals === false, 'clean: only a finished install is fine for proposals');
say(cleanReading({ ...good, things: ['inverter', 'spaceship'] }).tags.includes('spaceship') === false && THINGS.includes('inverter'), 'clean: a thing off the list is dropped');
say(cleanReading({ ...good, kind: 'made up' }).kind === 'other', 'clean: a kind off the list becomes other');
say(cleanReading({ unreadable: true }).unreadable === true && cleanReading(null).okForProposals === false, 'clean: an unreadable or empty answer stores nothing risky');
say(jobEquipment({ pylon_data: { storage_types: [{ description: 'Sigenergy SigenStor BAT 10.0' }], module_types: [{}] } }).join('|') === 'Sigenergy SigenStor BAT 10.0', 'equipment: the Pylon models, blanks left out');
say(/\/render\/image\/public\/site-photos\/a\/1\.jpg\?width=1024/.test(tagImageUrl('https://x.supabase.co/storage/v1/object/public/site-photos/a/1.jpg')), 'image: the reader is given the resized copy');

// 2. The model, over the cases.
(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`skip  ${cases.cases.length} model cases: set ANTHROPIC_API_KEY to run them`);
    process.exit(failed ? 1 : 0);
  }
  const usage = { input_tokens: 0, output_tokens: 0 };
  // the same request the app makes (price-list-ai.js callClaude), with the key from the environment
  const call = async (content, maxTokens, opts = {}) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: maxTokens, ...(opts.effort ? { output_config: { effort: opts.effort } } : {}), messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = await res.json();
    return { raw: data.content.map((b) => b.text || '').join('').trim(), usage: data.usage || {} };
  };
  for (const c of cases.cases) {
    try {
      const r = await tagPhoto({ url: cases.base_url + c.image, equipment: c.equipment || [], call });
      usage.input_tokens += (r.usage || {}).input_tokens || 0;
      usage.output_tokens += (r.usage || {}).output_tokens || 0;
      const missing = (c.expect.has || []).filter(t => !r.tags.includes(t));
      const wrong = (c.expect.not || []).filter(t => r.tags.includes(t));
      const kindOk = !c.expect.kind || c.expect.kind.includes(r.kind);
      say(!missing.length && !wrong.length && kindOk, c.id, `tags: ${r.tags.join(', ')}${missing.length ? ` | missing: ${missing.join(', ')}` : ''}${wrong.length ? ` | should not have: ${wrong.join(', ')}` : ''}${kindOk ? '' : ` | kind ${r.kind}`}`);
    } catch (err) {
      say(false, c.id, `error: ${err.message}`);
    }
  }
  console.log(`\n${cases.cases.length} pictures: ${usage.input_tokens} tokens in, ${usage.output_tokens} out (${Math.round((usage.input_tokens + usage.output_tokens) / cases.cases.length)} a picture)`);
  process.exit(failed ? 1 : 0);
})();
