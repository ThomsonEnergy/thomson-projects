// The request body for every Claude call. Text cut by character count
// (clip, slice) can end on half an emoji: JavaScript strings are UTF-16,
// an emoji is two units, and a cut between them leaves a lone surrogate.
// JSON.stringify writes that as "\ud83d", which the API refuses with
// "The request body is not valid" (Postie failed on one such email for
// four days, 23 to 27 Oct 2026). This strips any lone surrogate from every
// string in the body, so no cut can break a request again.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function claudeJson(body) {
  return JSON.stringify(body, (key, value) => (typeof value === 'string' ? value.replace(LONE_SURROGATE, '') : value));
}

// A cut that never lands between the two halves of an emoji.
function safeSlice(s, n) {
  const out = String(s || '').slice(0, n);
  const last = out.charCodeAt(out.length - 1);
  return last >= 0xD800 && last <= 0xDBFF ? out.slice(0, -1) : out;
}

// One-shot answers (a scope of works, a summary, a JSON extract). Claude Sonnet 5.5 thinks by default
// and the thinking counts against max_tokens, so a small ceiling cut answers off mid-sentence or left
// them empty (the scope of works, 12 Nov 2026). quickJson turns thinking off the way that model allows
// ('between_tools': it answers straight away) and gives a long answer room; claudeText reads the answer
// and says so when it was still cut off or declined, so half an answer is never saved.
const QUICK_MAX_TOKENS = 4000;
function quickJson(body) {
  return claudeJson({
    ...body,
    max_tokens: Math.max(body.max_tokens || 0, QUICK_MAX_TOKENS),
    ...(body.model === 'claude-sonnet-5-5' ? { thinking: { type: 'between_tools' } } : {}),
  });
}

function claudeText(data) {
  if (data.stop_reason === 'max_tokens') throw new Error('The AI answer came back cut off. Try again.');
  if (data.stop_reason === 'refusal') throw new Error('The AI declined this one. Change the wording and try again.');
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

module.exports = { claudeJson, safeSlice, quickJson, claudeText };
