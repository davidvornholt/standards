---
name: prs
description: Use when opening or landing a pull request, or changing its title or description.
---

# Pull requests

A pull request delivers one coherent outcome, together with the migrations, tests, and supporting changes it needs. It lands as one commit, so propose separate pull requests for independent outcomes.

## Draft and ready

CI runs the full gate only on pull requests marked ready. Keep a pull request in draft while work continues, and mark it ready with `gh pr ready` once the repository gate passes locally on the final commit. Each move to ready starts a full run, so convert it back with `gh pr ready --undo` before pushing more changes. Unless you are about to land the pull request, report that run as pending instead of waiting for it.

## Title and description

Pull requests squash into main with the title as the commit subject and the description as the commit body, so keep both accurate until the merge. The title is a Conventional Commit subject, `type(scope): description`, with an optional scope and an imperative description.

Write the description for whoever decides on the merge. Open with these two short paragraphs and nothing above them, because they should be enough to decide on:

```md
**Before.** The current state, who or what it affects, and its concrete cost or risk.

**Now.** The resulting state and how it resolves that problem.
```

For a new capability, `Before` names the missing ability, the current workaround, or the cost or risk of going without it. That the feature didn't exist gives the decider nothing to weigh. When behavior stays the same, as in a refactor, `Before` gives the reason for the change and `Now` says that behavior is unchanged.

When the pull request resolves an issue, the issue already holds the problem and its evidence. Summarize the problem in a sentence and link the issue with `Closes #<number>` instead of restating it.

Add further sections only when the change needs them:

- `## Implementation` gives the details needed to review the implementation.
- `## Breaking change` names the affected consumers and the migration each must make.
- `## Screenshots` belongs to the `screenshots-in-prs` skill, which applies to any change to rendered UI.

End the description with one line naming what opened the pull request: the model with its version, the agent harness, and any app that wraps the harness, such as `Opened by Claude Opus 5.5 in Claude Code via T3 Code.` Take each from your context, and write `unknown` for anything it doesn't state rather than guessing. Keep the line when another agent updates the description.

## Verification

Always include `## Verification` with `### Completed checks`: one line per check, naming what ran and how much of it passed, including partial runs and failures.

Add `### Check it yourself` only when a reviewer can confirm the behavior interactively or visually. Give the exact `gh pr checkout <number-or-branch>` command, the shortest steps, and the expected result.

## Landing

Before landing a pull request of any size, run the `review-fix` skill if you judge that a reviewer could find a bug in it that someone would otherwise run into. Standards syncs are exempt, because a consumer can't change synced files.

Land with `nix run github:davidvornholt/standards -- land <pr>`, never with `gh pr merge`. It runs the standards CLI from `main`, so it works whatever CLI version the repository pins. Run it from any checkout of the repository or from inside the pull request's worktree; without `<pr>`, it lands the current branch's pull request. It needs `git` and a signed-in `gh`. It waits until the checks on the pull request's current head have passed, squash-merges exactly that head, deletes the local branch, and waits for the runs the merge starts, such as a deploy. GitHub can't require checks in private repositories on its free plan, and there `land`'s wait is the only gate.

When no workflow at the pull request's head runs on pull requests or pushes, `land` merges at once, so run the repository's gate on the final commit first. Add `--no-wait` only when the change can't affect the checks, as for a change to documentation only, or when the repository's workflows run only on pushes to other branches, such as `main`, where `land` would wait 45 minutes for checks that never come. It still refuses a failed check, still waits for a check skipped before the pull request was marked ready, and never overrides the repository's rules. `land` refuses merge options such as `--auto` or `--admin`, because where nothing requires checks, `--auto` merges before CI has run.

`land` marks a draft ready, updates the branch when GitHub requires it to be up to date, and waits up to 45 minutes for the checks. A pull request that changed less than a minute ago counts as not yet checked, because CI starts with a delay. When a workflow at the merge commit runs on pushes, `land` then waits up to 60 minutes for the push runs on the merge commit and for every run started through `workflow_run` after the merge. Stopping it after the merge leaves the merge in place. Its exit code says what happened:

- **0:** merged, and the runs after the merge passed or there were none. Cleanup problems are only warnings.
- **1:** nothing merged, and the message says why. When a check failed because of a problem already fixed on the base branch, run `gh pr update-branch <pr>` and then `land` again.
- **2:** merged, but a run after the merge isn't green or couldn't be read. Check the linked run now. GitHub files a run started through `workflow_run` under the default branch's newest commit, so a red one may come from another pull request.

`land` deletes the pull request's local branch only when every commit on it is part of the merged pull request, and leaves remote branches to GitHub's "Automatically delete head branches" setting. When it lands the current branch, it needs a clean working tree, then switches to the base branch and fast-forwards it. Inside a worktree whose base branch is checked out elsewhere, it leaves the worktree detached; remove it with `git worktree remove <path>`. Running `land` on a merged pull request only cleans up, so it's safe to repeat, but its exit code then says only whether the cleanup worked.
