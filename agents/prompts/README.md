# Agent prompts

One file per agent, the system prompt and rules it runs with, separate from the code that calls it. `docs/AI_AGENTS_PLAN.md` decided this on 18 Oct 2026; the folder went in on 27 Oct 2026 with the software factory (`docs/SOFTWARE_FACTORY.md`). Prompts still inside code (`_shared/email-agent.js`, `_shared/chat-ai.js`, `ai-chat-background.js`, `_shared/ops-actions.js`) move here one agent at a time, each move as its own PR with the agent's eval set run before and after.

Layout:

```
agents/prompts/<agent>.md      the prompt, plain text, in the owner's style (no em dashes)
agents/evals/<agent>/          real cases (names removed) with the right answer
```

Code loads a prompt with `fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'prompts', '<agent>.md'), 'utf8')` and fills the live parts (label list, job list, mailbox owner) in from the database at run time. Anything a person should be able to change without a deploy (question sets, label rules) is not in the prompt at all: it is a settings table with a screen.

Agents today: Postie (email), Tally (supplier bills), the price list reader, the Knowledge Base reader, the chat tagger, Sparky (chat and Ask AI, also the ops manager view), the sweeps (job booked, quote expiry, licence expiry, booking reminders).
