---
name: review-fix
description: Use for a review with fixes or a review loop. Runs one autonomous, bounded review → fix → verify cycle on a pull request with a small lens fan-out.
---

# Review and fix

Run one bounded cycle: establish the baseline, review the initial diff, fix merge blockers, verify the fix delta, run the final gate, report, and stop. Use a draft PR in a dedicated worktree and add new commits only.

## Model

An explicit user choice wins. Otherwise use Claude Opus 5 at high effort in Claude Code, GPT-5.6 Luna at max effort in a GPT-capable harness, or the current model when neither is available. Use the same model for every lens.

## Scope

Read `.agents/review/decisions.md`. Post one scope comment with the intent, threat model, out-of-scope work, and selected lenses. Ask about splitting only when the PR contains independent product outcomes.

Choose distinct lenses:

| Diff | Lenses |
| --- | ---: |
| Prose or static copy only | 1 |
| Ordinary behavior or configuration | 2 |
| One high-risk family or large cross-system change | 3 |
| Several independent high-risk families | 4 maximum |

The default pair is:

1. **Behavior and invariants:** correctness, error paths, state transitions, edge cases, and meaningful tests.
2. **Premise and integration:** whether the change solves the stated problem and preserves architecture, compatibility, and operational contracts.

Add a specialized lens only when a material risk such as authorization, persistence, concurrency, deployment provenance, untrusted output, or complex accessibility otherwise lacks an owner.

## Baseline and review

Reuse a successful equivalent exact-head gate. Otherwise run the repository gate once. Repair only PR-introduced mechanical failures before review and record pre-existing failures.

Review the base to the initial head. Retry a skipped lens once, then stop if coverage is still incomplete. Merge duplicate findings and assign one decision:

- `block`: demonstrated, in scope, material, and worth stopping the merge;
- `defer`: real but outside this PR or below the merge bar;
- `discard`: refuted, speculative, already accepted, or not worth scheduling;
- `ask`: a costly, durable product or architecture choice remains unresolved.

Do not ask about inferable implementation details, naming, local refactors, test shape, or other reversible choices. Choose the smallest sound option and record durable assumptions.

## Fix

Create one review thread per blocker. A worker reproduces the failure, makes the smallest correction, and runs focused checks.

Add at most one regression test per failure class, preferably by extending existing coverage. Do not add a dependency, fixture framework, generic guard, or browser test for a single finding unless the behavior genuinely requires it.

Keep blocker threads unresolved until their focused verification and the final gate pass.

## Verify

Review only the fix commits. Skip fresh review for prose-only changes and isolated tests that do not alter shared fixtures, schemas, workflows, generated data, global mocks, or test infrastructure. Otherwise use one targeted lens, or two for two independent invariant families.

One unresolved original blocker or one fix-introduced defect may trigger one repair round. Fresh-review that repair only when it touches secrets, authorization, persistence, migrations, recovery, concurrency, cache identity, artifact provenance, or authoritative untrusted output.

Run the full deterministic gate once after the last change. Fix cycle-introduced gate failures mechanically without starting another review pass.

## Report and stop

Post the report and mark the PR ready unless an `ask` remains. Open with:

| Phase | Scope | Model / lenses | Findings | Outcome | Duration |
| --- | --- | --- | --- | --- | ---: |
| Baseline gate | exact initial head | deterministic | — | reused or passed | elapsed |
| Review | base → initial head | model × lenses | decision counts | fixed or clean | elapsed |
| Fix verification | fix delta | model × 0–2 lenses | decision counts | repaired, clean, or skipped | elapsed |
| Repair verification | repair delta | model × 0–2 lenses | decision counts | final repair, clean, or skipped | elapsed |
| Final gate | exact final head | deterministic | — | passed or failed | elapsed |

Then include each finding and decision, lens yield, assumptions, tests, deferred work, residual risk, and total wall-clock duration. Hand the merge decision to the human and stop.
