---
name: review-fix
description: Use when asked to review a pull request and fix its findings in the same review loop. Runs one bounded review, repair, and verification cycle.
---

# Review and fix

Review-fix runs one bounded review-and-fix cycle on a pull request, then reports and stops.

Every review of a fix finds something in the fix, so reviewing until the pull request comes back clean never converges. Don't start another cycle for findings this cycle created, and don't give the final repair a fresh review.

Work in a dedicated worktree on a draft pull request. Add new commits rather than amending or force-pushing.

## Reviewer model

Reviewers use GPT-6 Astra at high effort unless the user names another model. That model runs every review and verification lens. The orchestrating session and the fix workers stay on the current model.

Start each lens as a native subagent when the harness can run the reviewer model, and set the model and effort explicitly on every spawn. When the harness can't run it, as Claude Code can't run GPT, delegate the lens with T3 Code `delegate_task`. Include the lens brief, the review skill's path, and the read-only constraint in the delegated task. If neither route can start the reviewer model, stop before reviewing and report which model couldn't start and why. Never substitute another model.

## Scope

Before any finding exists, post one scope comment on the pull request with the intent, threat model, out-of-scope work, and the selected lenses. Its timestamp starts the cycle. Ask about splitting the pull request only when it contains independent product outcomes.

Choose the number of lenses from the diff:

| Diff | Lenses |
| --- | ---: |
| Prose or static copy only | 1 |
| Ordinary behavior or configuration | 2 |
| One high-risk family or large cross-system change | 3 |
| Several independent high-risk families | 4 maximum |

Each lens is a separate reviewer with its own context, a distinct failure class, and explicit exclusions. The default pair is:

1. Behavior and invariants: correctness, error paths, state transitions, edge cases, and meaningful tests.
2. Premise and integration: whether the change solves the stated problem and preserves architecture, compatibility, and operational contracts. This lens also owns documentation that breaks the documentation rule, and any material finding no other lens owns.

Add a third or fourth lens only for a material risk that would otherwise have no owner, such as authorization or concurrency. Name that failure class in the scope comment.

## Baseline

Reuse a successful gate that already finished on an equivalent exact head. Otherwise run the repository gate locally once rather than waiting for CI. Repair only mechanical failures the pull request introduced, and record pre-existing ones.

## Review

Run every lens as a separate read-only subagent on the reviewer model, using the [review skill](../review/SKILL.md). Give each one the range from the pull request's base to its initial head, the scope comment, the gate result, its lens and exclusions, and any model override. Retry a lens that doesn't report once. If coverage is still incomplete, stop instead of fixing from a partial review.

Merge duplicate findings, keeping every lens that reported each one, and give each merged finding one decision as the review skill defines them. Collect every remaining `ask` into one decision brief with the options, their consequences, and a recommendation.

## Fix

Give each blocker its own self-contained review thread on the pull request, and fix it with a worker subagent. The worker reproduces the failure first, makes the smallest correction, and runs focused checks. If it can't reproduce the failure, it leaves the thread unresolved and the finding is reclassified rather than fixed on speculation. A documentation blocker needs no reproduction: cut the quoted passages.

Keep each fix the size of its finding, without new machinery, because new machinery attracts findings of its own. Add the regression test the review skill describes, at most one per failure class, ideally one that fails on the pre-fix behavior.

## Verify

Review only the fix commits, from the pre-fix head, with one targeted lens, or two when the fixes touch two independent invariant families. Skip this review when the fixes are prose or static copy, or isolated tests that don't change shared test infrastructure.

A verification finding triggers one repair round only if it is an original blocker that remains unresolved, or a defect the fixes introduced. Defer or discard a defect that already exists at the pre-fix head. Fresh-review the repair, with the same lens limit, only when it touches high-risk behavior such as authorization, persistence, or concurrency.

If that review finds a material defect, make one final repair, verify it mechanically only, and stop repairing. Then run the full deterministic gate locally once, after the last change. Fix gate failures the cycle introduced mechanically, without another review pass. Resolve the blocker threads once their verification and the final gate pass.

## Report and stop

Post the report on the pull request and mark it ready with `gh pr ready`, unless an `ask` is still open. Report the CI run that this starts as pending rather than waiting for it. Open the report with this table, with a row for every phase, including skipped ones:

| Phase | Scope | Model / lenses | Findings | Outcome | Duration |
| --- | --- | --- | --- | --- | ---: |
| Baseline gate | exact initial head | deterministic | — | reused or passed | elapsed |
| Review | base → initial head | model × lenses | decision counts | fixed or clean | elapsed |
| Fix verification | fix delta | model × 0–2 lenses | decision counts | repaired, clean, or skipped | elapsed |
| Repair verification | repair delta | model × 0–2 lenses | decision counts | final repair, clean, or skipped | elapsed |
| Final gate | exact final head | deterministic | — | passed or failed | elapsed |

After the table, link each finding with its decision, impact, and reporting lenses. Then report lens yield, assumptions, tests added or extended, any new test machinery, deferred work, residual risk, and any final repair that no fresh reviewer saw. Measure the total wall-clock duration from the scope comment to the report.

Then stop, whatever the outcome. The merge decision belongs to the user.
