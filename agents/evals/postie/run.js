// Runs Postie's filing cases (cases.json) through the real label pass
// (_shared/email-agent.js chooseLabels) and prints pass or fail per case.
//
//   ANTHROPIC_API_KEY=... node agents/evals/postie/run.js
//
// The key is the one in the api_keys table (Settings > Integrations); copy it into the
// environment for the run, never into the repo. Also checks the code's own evidence
// check (evidenceFound) with no API call, so that part runs anywhere.
const path = require('path');
const { chooseLabels, evidenceFound, mentionsLabel } = require(path.join(__dirname, '..', '..', '..', 'netlify', 'functions', '_shared', 'email-agent.js'));
const { withoutSignOff } = require(path.join(__dirname, '..', '..', '..', 'netlify', 'functions', '_shared', 'build-email-signature.js'));

const cases = require('./cases.json');
let failed = 0;
const say = (ok, id, detail) => { if (!ok) failed++; console.log(`${ok ? 'pass' : 'FAIL'}  ${id}${detail ? `  ${detail}` : ''}`); };
const CODE_CHECKS = 10;

// 1. Code-only checks: the evidence rule and the pre-filter.
say(evidenceFound('GC Wind Services', 'Subject: ... ats GC Wind Services Pty Ltd ...'), 'evidence: exact words found');
say(!evidenceFound('GC Wind Services', 'Subject: Case Conference Summary - Mr Someone'), 'evidence: words not in the email are refused');
say(!evidenceFound('ats', 'Subject: ats GC Wind'), 'evidence: a three-letter word alone is not evidence');
say(mentionsLabel(cases.labels, 'Subject: GCW dispute, next steps'), 'pre-filter: every word of a label name in the thread');
say(!mentionsLabel(cases.labels, 'Subject: solar quote for 12 Smith St, panel clean photo'), 'pre-filter: one common word from a label name is not enough');

// Drafts and typed replies: a sign off at the end is dropped on sending, the signature adds it.
say(withoutSignOff('Hi Bob,\n\nYes, Tuesday works.\n\nKind regards,', 'Jasper Thomson') === 'Hi Bob,\n\nYes, Tuesday works.', 'sign off: "Kind regards," on its own is dropped');
say(withoutSignOff('Yes, Tuesday works.\n\nKind regards,\nJasper\n', 'Jasper Thomson') === 'Yes, Tuesday works.', 'sign off: with the first name under it is dropped');
say(withoutSignOff('Yes, Tuesday works.\nCheers\nJasper Thomson', 'Jasper Thomson') === 'Yes, Tuesday works.', 'sign off: "Cheers" with the full name is dropped');
say(withoutSignOff('Thanks for your patience.', 'Jasper Thomson') === 'Thanks for your patience.', 'sign off: a real last line stays');
say(withoutSignOff('Kind regards,', 'Jasper Thomson') === 'Kind regards,', 'sign off: a body that is only a sign off is left alone');

// 2. The model, over the cases.
(async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log(`skip  ${cases.cases.length} model cases: set ANTHROPIC_API_KEY to run them`);
    process.exit(failed ? 1 : 0);
  }
  const codeFailed = failed;
  const items = cases.cases.map((c) => ({
    id: c.id,
    text: `Subject: ${c.input.subject}\nFROM ${c.input.from} (2026-10-20):\n${c.input.body_gist}`,
    conversation: !!c.input.conversation,
  }));
  const usage = { input_tokens: 0, output_tokens: 0 };
  const picks = await chooseLabels(apiKey, { who: 'the shared sales@thomsonenergy.com.au inbox', labels: cases.labels, items }, usage);
  for (const c of cases.cases) {
    const p = picks[c.id] || { label: '', sure: false, verified: false, new_label: '' };
    const applied = p.label && p.sure && p.verified ? [p.label] : [];
    const want = c.expect.labels || [];
    const newOk = c.expect.new_label_prefix !== undefined
      ? (p.new_label || '').toLowerCase().startsWith(c.expect.new_label_prefix.toLowerCase()) && p.sure && p.verified
      : (c.expect.new_label === undefined || (p.new_label || '') === c.expect.new_label);
    const ok = JSON.stringify(applied) === JSON.stringify(want) && newOk;
    say(ok, c.id, `applied ${JSON.stringify(applied)} (model said "${p.label}", sure ${p.sure}, evidence "${p.evidence}" ${p.verified ? 'found' : 'not found'}${p.new_label ? `, new label "${p.new_label}"` : ''}), wanted ${JSON.stringify(want)}`);
  }
  console.log(`${CODE_CHECKS} code checks, ${codeFailed} failed; ${cases.cases.length} model cases, ${failed - codeFailed} failed, ${usage.input_tokens + usage.output_tokens} tokens`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('run failed:', e.message); process.exit(2); });
