---
name: ship
description: Step 4 of the software factory (Ship). Open the PR with before and after proof, screenshots on the pr-assets branch, the PR template filled in, docs written back, then merge by the release rules. Use after /prove passes.
---

# /ship

## 1. Screenshots onto the `pr-assets` branch

Screenshots show real job data, so they never go to a public image host. They live on a branch in this private repo that is never merged.

```
git fetch origin pr-assets 2>/dev/null || true
git worktree add ../pr-assets origin/pr-assets 2>/dev/null \
  || (git worktree add --detach ../pr-assets && git -C ../pr-assets checkout --orphan pr-assets && git -C ../pr-assets rm -rfq . 2>/dev/null)
mkdir -p ../pr-assets/<branch-name>
cp smoke/before/*.png smoke/after/*.png ../pr-assets/<branch-name>/   # keep before/ and after/ as subfolders
git -C ../pr-assets add -A && git -C ../pr-assets commit -qm "Screenshots for <branch-name>" && git -C ../pr-assets push -u origin pr-assets
```

Link each image as `https://github.com/ThomsonEnergy/thomson-projects/blob/pr-assets/<branch-name>/after/<file>.png?raw=true` (the owner is logged in to GitHub, so the links open for them).

## 2. The PR

- Commit with a plain message (what and why, one line, body if needed). Push with `git push -u origin <branch>`.
- Open the PR with the REST API (GraphQL is not available from cloud sessions): `gh api repos/ThomsonEnergy/thomson-projects/pulls -f base=<staging or main> -f head=<branch> -f title=... -f body=...`. Base is `staging` for a feature, `main` for a bug fix or docs (release rules in `CLAUDE.md`).
- Body follows `.github/pull_request_template.md`, every section filled: What and why, **Done means** ticked, the before and after table from `smoke/table.md` with the screenshot links swapped in, Checks, Removed, Touches. A section left empty is a reason to go back to `/prove`.

## 3. Write it back

Before the final reply, as `CLAUDE.md` "Keep every chat in the loop" says: a dated line in `docs/DECISIONS.md`, the detail in `docs/PROJECT_SPEC.md` (now built), the backlog item moved to built, `docs/AI_AGENTS_PLAN.md` if an agent changed. Same PR.

## 4. Merge

- Wait for the `check` tick (`gh api repos/ThomsonEnergy/thomson-projects/commits/<sha>/check-runs`).
- Feature: merge into `staging` once whole and green (merge commit). Bug fix: production migration after the owner's yes, merge into `main`, then merge `main` into `staging`.
- Tell the owner in one line what to click on staging to see it, and the PR link.

Afterwards, `/weekly-cleanup` keeps it tidy.
