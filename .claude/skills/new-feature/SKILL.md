---
name: new-feature
description: Step 1 of the software factory (Isolate). Start a feature or bug fix on its own branch from the right base, after checking nothing else is building on the same files. Use at the start of any build, right after the owner's yes.
---

# /new-feature <short-name>

Every build starts here, after the plan has its yes. Never build on `main` or `staging`.

1. `git fetch origin main staging`.
2. **Overlap check**, three places, before making the branch:
   - `git branch -r --no-merged origin/staging` (branches still building) and the open PRs (`gh api repos/ThomsonEnergy/thomson-projects/pulls --jq '.[] | "\(.number) \(.head.ref) \(.title)"'`).
   - `docs/IDEAS_BACKLOG.md`: items marked "Building in" or "waiting on yes" that list the same files in their Touches line.
   - If another branch touches the same page or function: stop, say "build this in that chat" with the branch or PR number, and do not make a branch.
3. **Make the branch from the right base:**
   - Feature or update: `git checkout -b feat/<short-name> origin/staging`.
   - Bug fix (something live is wrong): `git checkout -b fix/<short-name> origin/main`.
   - On the laptop, where several chats share one folder, use a worktree instead so chats cannot tread on each other: `git worktree add ../te-<short-name> -b feat/<short-name> origin/staging` and work in that folder. Cloud sessions are already their own copy.
4. **Claim it:** add "Building in: `feat/<short-name>`" to the backlog item (or add the item with its Touches line if the plan was only in chat), commit and push that one line straight away so other chats see the claim before any code exists.
5. Write the plan's **Done means** list (3 to 6 checks a person could do by clicking) at the top of the PR body draft; `/prove` and `/ship` use it.

Then build with `/code-structure`.
