---
name: prs
description: Use when opening a pull request or changing its title or description. Produces a decision-ready, reproducible change record.
---

# Pull requests

A pull request delivers one coherent outcome, together with the migrations, tests, and supporting changes it needs. It lands as one commit, so propose separate pull requests for independent outcomes.

## Draft and ready

CI runs the full gate only on pull requests marked ready, because running it on every intermediate push was costly. Keep a pull request in draft while work continues, and mark it ready with `gh pr ready` once the repository gate passes locally on the final commit. Each move to ready starts a full run, so convert it back with `gh pr ready --undo` before pushing more changes. Unless you are about to merge, report that run as pending instead of waiting for it.

## Title and description

Pull requests squash into main with the title as the commit subject and the description as the commit body, so keep both accurate until the merge. The title is a Conventional Commit subject, `type(scope): description`, with an optional scope and an imperative description.

Write the description for whoever decides on the merge, who has no background on the problem and hasn't read the code. Open with these two short paragraphs and nothing above them, because they should be enough to decide on:

```md
**Before.** The current state, who or what it affects, and its concrete cost or risk.

**Now.** The resulting state and how it resolves that problem.
```

For a new capability, `Before` names the missing ability, the current workaround, or the cost or risk of going without it. That the feature didn't exist gives the decider nothing to weigh. When behavior stays the same, as in a refactor, `Before` gives the reason for the change and `Now` says that behavior is unchanged.

When the pull request resolves an issue, the issue already holds the problem and its evidence. Summarize the problem in a sentence and link the issue with `Closes #<number>` instead of restating it.

Add further sections only when the change needs them, and don't repeat what another section says:

- `## Implementation` gives the details needed to review the implementation.
- `## Breaking change` names the affected consumers and the migration each must make.
- `## Screenshots` belongs to the `screenshots-in-prs` skill, which applies to any change to rendered UI.

## Verification

Always include `## Verification` with `### Completed checks`: one line per check with its exact result. The decider relies on these lines instead of rerunning the checks, so name what ran and how much of it passed, including partial runs and failures.

Add `### Check it yourself` only when a reviewer can confirm the behavior interactively or visually. Give the exact `gh pr checkout <number-or-branch>` command, the shortest steps, and the expected result.
