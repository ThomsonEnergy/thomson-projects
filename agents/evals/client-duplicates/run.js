// Runs the client duplicate scan's checks (backlog item 110).
//
//   node agents/evals/client-duplicates/run.js                      the code's own rules, no API call
//   ANTHROPIC_API_KEY=... node agents/evals/client-duplicates/run.js  and the model over cases.json
//
// The key is the one in the api_keys table (Settings > API Keys); copy it into the environment for
// the run, never into the repo. The cases are made up (no real client is in this folder).
const path = require('path');
const shared = (f) => path.join(__dirname, '..', '..', '..', 'netlify', 'functions', '_shared', f);
const { candidatePairs, cleanVerdict } = require(shared('client-duplicates.js'));
const { looksLikeBusiness } = require(shared('client-abns.js'));
const { CLIENT_DUPLICATES_PROMPT } = require(path.join(__dirname, '..', '..', 'prompts', 'client-duplicates.js'));
const cases = require('./cases.json');

let failed = 0;
const say = (ok, id, detail) => { if (!ok) failed++; console.log(`${ok ? 'pass' : 'FAIL'}  ${id}${detail ? `  ${detail}` : ''}`); };

// 1. Code-only checks.
const c = (id, name, extra = {}) => ({ id, name, client_type: 'individual', ...extra });
const list = [
  c('01', 'Ocean Blue Metal Roofing', { email: 'jobs@ob.test' }), c('02', 'Ocean Blue', { email: 'accounts@ob.test' }),
  c('03', 'Smith Electrical Pty Ltd', { abn: '11 222 333 444' }), c('04', 'SMITH ELECTRICAL', { abn: '11222333444' }),
  c('05', 'Pat Lee', { phone: '0400 123 456' }), c('06', 'Patricia Lee', { phone: '+61 400 123 456' }),
  c('07', 'Jo'), c('08', 'Jo Brown'),
  ...['09', '10', '11', '12', '13'].map((id) => c(id, `Customer ${id}`, { email: 'office@bigbuilder.test' })),
];
const pairs = candidatePairs(list);
const has = (x, y) => pairs.find((p) => p.a.id === x && p.b.id === y);
say(!!has('01', '02') && /one name inside the other/.test(has('01', '02').why), 'pairs: one name inside the other');
say(!!has('03', '04') && /same ABN/.test(has('03', '04').why) && /same name/.test(has('03', '04').why), 'pairs: same ABN and same name, listed once with both reasons');
say(!!has('05', '06') && /same phone/.test(has('05', '06').why), 'pairs: the same phone written two ways');
say(!has('07', '08'), 'pairs: a one word name inside another is not a pair');
say(!pairs.some((p) => ['09', '10', '11', '12', '13'].includes(p.a.id)), 'pairs: an email on five records (a builder) pairs nobody');
say(pairs[0].a.id === '03', 'pairs: the strongest reason comes first');
say(pairs.every((p) => p.a.id < p.b.id), 'pairs: always the lower id first');

const pair = { a: c('a1', 'A', { abn: '11222333444' }), b: c('b1', 'B', { abn: '99888777666' }) };
const facts = { a1: { jobs: 1, invoices: 0 }, b1: { jobs: 4, invoices: 3 } };
say(cleanVerdict({ verdict: 'same', keep: 'A', confidence: 0.9 }, pair, facts).verdict === 'apart', 'clean: different ABNs are never the same customer');
const noAbn = { a: c('a1', 'A'), b: c('b1', 'B') };
say(cleanVerdict({ verdict: 'same', keep: 'B', confidence: 0.9, reason: 'x' }, noAbn, facts).keepId === 'b1', 'clean: keep is the record the AI named');
say(cleanVerdict({ verdict: 'same', keep: 'C', confidence: 3 }, noAbn, facts).keepId === 'b1' && cleanVerdict({ verdict: 'same', confidence: 3 }, noAbn, facts).confidence === 1, 'clean: a bad keep falls back to the record with the work on it, confidence is capped');
say(cleanVerdict({ verdict: 'merge them now' }, noAbn, facts).verdict === 'unsure' && cleanVerdict(null, noAbn, facts).verdict === 'unsure', 'clean: a verdict off the list, or no answer, is unsure');
say(cleanVerdict({ verdict: 'apart', keep: 'A' }, noAbn, facts).keepId === null, 'clean: apart keeps nobody');
say(cleanVerdict({ verdict: 'unsure', confidence: 0.99 }, noAbn, facts).confidence <= 0.5, 'clean: unsure is never shown as certain');
say(!/—/.test(cleanVerdict({ verdict: 'same', reason: 'Same email — same phone' }, noAbn, facts).reason), 'clean: no em dash reaches the screen');

say(looksLikeBusiness({ name: 'Ocean Blue Metal Roofing', client_type: 'individual' }), 'abn: a roofing business labelled Individual is searched');
say(looksLikeBusiness({ name: 'Pat Lee', client_type: 'company' }), 'abn: a client labelled Company is searched');
say(!looksLikeBusiness({ name: 'Margaret Olsen', client_type: 'individual' }) && !looksLikeBusiness({ name: 'Daniel Ferro', client_type: 'individual' }), 'abn: a homeowner is never searched');
say(looksLikeBusiness({ name: 'J & M Carter', client_type: 'individual' }), 'abn: a name with an ampersand is searched');

// 2. The model, over the cases.
(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`skip  ${cases.cases.length} model cases: set ANTHROPIC_API_KEY to run them`);
    process.exit(failed ? 1 : 0);
  }
  const fetch = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'node-fetch'));
  const line = (x) => [`name "${x.name}"`, x.client_type, x.email ? `email ${x.email}` : 'no email', x.phone ? `phone ${x.phone}` : 'no phone', x.abn ? `ABN ${x.abn}` : 'no ABN', x.address ? `address ${x.address}` : 'no address',
    `${x.facts.jobs} jobs, ${x.facts.quotes} quotes, ${x.facts.invoices} invoices, ${x.facts.sites} sites, ${x.facts.contacts} contacts`, `last used ${x.facts.lastUsed}`].join('; ');
  const text = cases.cases.map((k, i) => `Pair ${i + 1} (paired because: ${k.why})\n  A: ${line(k.a)}\n  B: ${line(k.b)}`).join('\n\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 4000, messages: [{ role: 'user', content: CLIENT_DUPLICATES_PROMPT.replace('{{pairs}}', text) }] }),
  });
  const data = await res.json();
  const raw = (data.content || []).map((b) => b.text || '').join('');
  const answers = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1));
  cases.cases.forEach((k, i) => {
    const a = answers.find((x) => Number(x.pair) === i + 1) || {};
    say(a.verdict === k.want && (!k.keep || a.keep === k.keep), `model: ${k.id}`, `got ${a.verdict}${a.keep ? ` keep ${a.keep}` : ''}: ${a.reason || ''}`);
  });
  process.exit(failed ? 1 : 0);
})();
