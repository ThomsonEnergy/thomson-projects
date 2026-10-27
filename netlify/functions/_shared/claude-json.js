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

module.exports = { claudeJson, safeSlice };
