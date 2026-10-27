# Agent eval sets

Every agent has a folder of real cases with the right answer. A change to an agent's prompt, model or code runs every case before it ships (`/prove`, step 2). A case is added every time a person corrects the agent (moves a label, undoes a tag, rewrites a draft), so the set grows from real mistakes, not made-up ones.

Layout:

```
agents/evals/<agent>/cases.json   the cases
agents/evals/<agent>/run.js       runs the agent's logic over the cases and prints pass or fail per case
```

A case holds the input as the agent would see it (names and private details removed or shortened), the answer it must give, and the reason in one line so the next person knows why. Pass means the agent's answer matches on the fields the case lists; other fields are not checked.

Runners are written per agent because each one's inputs differ (an email thread, a chat message, a PDF). Until an agent has a runner, its `cases.json` is still the list a chat checks by hand after a change, and the PR says so.

Sets today: `postie/` (filing and labels: 6 cases, the GCW dispute emails that were right and the 4 that were wrong on 27 Oct 2026, plus one topic label; `run.js` runs the code checks anywhere and the model cases with `ANTHROPIC_API_KEY` set).
