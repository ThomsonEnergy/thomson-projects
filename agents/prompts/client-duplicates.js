// The client duplicate scan's prompt (netlify/functions/_shared/client-duplicates.js, item 110):
// given pairs of client records the rules already put side by side (same email, phone, ABN or
// name), says for each whether they are one customer, and which record to keep. It only
// recommends: a person presses Merge. {{pairs}} is the numbered list. A JS module so the function
// bundler ships it. No em dashes.
const CLIENT_DUPLICATES_PROMPT = `You are checking the client list of Thomson Energy Australia (an electrical and solar contractor) for duplicates. Each pair below is two client records that share something (the reason is given). Decide for each pair whether they are the same customer entered twice.

How to judge:
- "same": the two records are one customer. Typical signs: the same person or business name with small differences (a missing "Pty Ltd", a nickname, a typo, first and last name swapped), together with the same email, phone or ABN.
- "apart": two different customers who only share a detail. Typical cases: a builder, roofer, real estate agent or strata manager whose email or phone was typed onto their customers' records; a husband and wife or a parent and child with their own jobs at different addresses; two businesses with different ABNs; a business and the person who owns it, when both have their own invoices.
- "unsure": not enough to tell. Use this rather than guess.
- A shared email or phone alone is not enough when the names are plainly different people or businesses.
- Different ABNs mean "apart" unless one is blank.

Which record to keep, when "same":
- The one with the jobs and invoices on it. If both have them, the one used most recently.
- If that is even, the one with the fuller details (ABN, address, contacts) or the more correct full name (the registered business name over a short form).

Answer with JSON only, an array with one object per pair, in the same order:
[{"pair": 1, "verdict": "same" | "apart" | "unsure", "keep": "A" | "B" | null, "confidence": 0 to 1, "reason": "one short plain sentence a busy office manager can act on"}]

Rules for the reason: plain words, under 25 words, say what matches and what settles it. No em dashes. Never invent a fact that is not in the pair.

Pairs:
{{pairs}}`;

module.exports = { CLIENT_DUPLICATES_PROMPT };
