---
name: review-fix
description: Use when asked to review a pull request and fix its findings in the same review loop.
---

# Review and fix

Run one round of review and fixes on a pull request, report, and stop. Reviewing a fix always turns up something, so never start another round for problems this one created.

Work in a dedicated worktree on a draft pull request. Add commits rather than amending or force-pushing. Note the time you start, because the report gives the total time.

## Reviewers

Reviewers use GPT-6 Astra at high effort unless the user names another model. Use `delegate_task` if your harness can't run it. If nothing can, stop and say why. Never substitute a model.

Each reviewer is a separate read-only agent that follows the [review skill](../review/SKILL.md) and looks for one kind of failure:

- Behavior: correctness, error paths, edge cases, and whether the tests can fail.
- Premise: whether the change solves the problem its description states and fits the architecture and operational contracts. This reviewer also owns documentation cuts and anything no other reviewer covers.

A prose-only change gets only the premise reviewer, and any other change gets both. Add up to two more only for a specific risk that the diff exposes, such as outbound mail or concurrency, because reviewers added for a general category often found nothing.

## Review

Reuse a gate that passed on this exact commit, or run it once, and fix only mechanical failures the pull request introduced.

Give each reviewer the range from base to head, the pull request's description, the gate result, its kind of failure, and the other reviewers' kinds. Retry one that doesn't report. If it still doesn't report, stop, because a partial review isn't a safe basis for fixes.

The label on each finding is your decision. Overrule a reviewer when the evidence supports it, and say so in the report. Put each `ask` to the user yourself, as AGENTS.md describes, rather than in the report.

## Fix

A worker on your own model fixes each blocker: it reproduces the failure, makes the smallest correction, adds the recommended test, and runs focused checks. If it can't reproduce the failure, don't fix it on speculation, and relabel the finding. Then make all cuts in one commit.

When a fix could lose data, weaken access, break a release, deploy, or backup path, or give customers wrong output, one reviewer reads only the fix commits. If it finds a blocker the fixes left or a defect they introduced, repair it once and confirm the repair with tests alone. Defer or drop anything that was already there.

Run the full gate after the last change.

## Report

File an issue with the [issues skill](../issues/SKILL.md) for each deferred finding that could still cause harm. Other deferred findings stay in the report, because minor ones filed as issues pile up until they get cleared in bulk.

Post one comment on the pull request, leaving out any part with nothing in it:

- One line with the reviewers, the final gate result, and the total time.
- One table row per finding: its file and line, what goes wrong, its label, and the commit that fixed it or why it wasn't fixed.
- Each reviewer you overruled, and why.
- Any risk that remains. If it would show only after deployment, name the check that covers it or file an issue for one.

Run `gh pr ready` unless an `ask` is open. If the user asked you to merge when you're confident and you are, wait for CI and merge. Otherwise report CI as pending, and stop.
