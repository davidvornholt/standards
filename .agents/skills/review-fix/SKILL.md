---
name: review-fix
description: Use for a review with fixes or a review loop. Runs one autonomous, bounded review → fix → verify cycle on a pull request with a small lens fan-out.
---

# Review and fix

Run one bounded cycle: freeze scope, establish a deterministic baseline, review, fix merge blockers, verify the fix delta, run the final gate, report, and stop. Never add passes until “clean,” start a second cycle for findings created by this cycle, amend published commits, or fresh-review the final repair.

## Reviewer model

An explicit user choice of model or effort overrides every default.

Otherwise use:

| Harness | Default reviewer |
| --- | --- |
| Claude Code | Claude Opus 5, high |
| Codex or another GPT-capable harness | GPT-5.6 Luna, max |
| Neither family available | the current/inherited model |

If an explicitly requested model cannot run, report an execution blocker instead of silently substituting another model. A missing default may fall back to the current model without asking. Use the same resolved model for every lens in the cycle; model selection is not a reason to pause.

Do not estimate token usage. Measure wall-clock duration from PR artifact timestamps.

## Setup and scope

- Work on a draft PR in a dedicated worktree; use new commits only.
- Read `.agents/review/decisions.md` when present.
- Post a scope comment containing **intent**, **threat model**, **out of scope**, and the selected lenses. Its timestamp starts the cycle.
- Ask about splitting only when the PR contains independent product outcomes, not merely a large coherent diff.

## Lens fan-out

Independent reviewers preserve attention, but every lens must own a distinct material failure class. Every reviewer reads the full diff and reports only its charter.

| Diff | Full-review lenses |
| --- | ---: |
| Prose, comments, or static copy only | 1 |
| Ordinary behavior or configuration | 2 |
| One high-risk family or a large cross-subsystem change | 3 |
| Several independent high-risk families | 4 maximum |

The ordinary pair is:

1. **Behavior and invariants** — correctness, error paths, state transitions, edge cases, and meaningful test coverage.
2. **Premise and integration** — whether the change solves the right problem and preserves cross-file, architecture, compatibility, and operational contracts; it also owns catch-all coverage.

Add a specialized lens only when a central family such as authorization, data integrity/concurrency, deployment provenance, untrusted output, or complex interaction/accessibility would otherwise lack an owner. Give lenses explicit exclusions. Every lens after the second needs a one-line justification.

## Baseline and review

Reuse a successful equivalent exact-head CI gate; otherwise run the repository gate once. Fix only PR-introduced mechanical failures before review and record base-preexisting failures.

Run `review-pass` over the PR base → initial head with the scope, gate result, decisions registry, lenses, and any explicit model override. Retry skipped lenses once; if coverage is still incomplete, stop with the execution blocker.

Each finding has one final decision:

- **block** — demonstrated, in scope, material under the threat model, and worth stopping this merge.
- **defer** — real but outside this PR or below the merge bar.
- **discard** — refuted, speculative, already accepted, or too low-value to schedule.
- **ask** — a durable product or architecture choice remains genuinely unresolved and choosing wrongly would be expensive to reverse.

Merge duplicate findings while preserving every reporting lens.

## Autonomy

Continue without asking about inferable implementation details, reversible product choices, naming or copy, local refactors, test shape inside existing infrastructure, or optional machinery that can be deferred. Choose the simplest in-scope option and record any durable assumption.

Use `ask` only when the request, code, tests, and decisions registry do not choose between materially different durable outcomes involving product semantics, data or wire contracts, broad ownership/lifecycle boundaries, or foundational architecture. Collect all unavoidable questions into one decision brief and one pause.

## Fixes and tests

Create one self-contained review thread per `block`, then dispatch the smallest sensible worker batches. A worker reproduces the failure first; if it cannot, leave the thread unresolved so the orchestrator can change the decision.

- Prefer a local fix, deletion, or narrower claim over new machinery.
- Run focused checks per worker batch, not the full gate.
- Add at most one minimal regression test per failure class, preferably by extending an existing or table-driven test.
- The test should fail on the pre-fix behavior when practical.
- Do not add a dependency, fixture framework, parser, generic harness, or shared guard for one finding.
- Use browser tests only for browser-specific behavior.
- Mechanization is optional; `none` is normal.

Keep block threads unresolved until required verification and the final gate pass.

## Verification and stop

Review only the fix commits:

- Skip fresh review for prose/static-copy deltas and isolated tests that do not change shared fixtures, schemas, workflows, seeded data, global mocks, or test infrastructure.
- Otherwise use one targeted lens; use two only for two independent invariant families.

Only an unresolved original block or a defect introduced by the fix can trigger one repair round. Base-preexisting defects are deferred or discarded.

Fresh-review the repair only when it touches auth/secrets, persistence/migrations/recovery, concurrency/retries/transactions, cache identity, artifact provenance, or untrusted output crossing an authoritative or persisted boundary. Use one lens normally, two maximum. If that review finds a material defect, make one final repair and verify it mechanically only.

After the last change, run the full deterministic gate once. Fix cycle-introduced gate failures mechanically; do not add another review pass. Resolve block threads after required verification and the final gate succeed.

## Report

Post the report and mark the PR ready, unless an `ask` remains. Open with this table; include every phase and explain skipped phases:

| Phase | Scope | Model / lenses | Findings | Outcome | Duration |
| --- | --- | --- | --- | --- | ---: |
| Baseline gate | exact initial head | deterministic | — | reused or passed | elapsed time |
| Review | base → initial head | actual model × lens count | block / defer / discard / ask counts | fixed or clean | elapsed time |
| Fix verification | pre-fix → fixed head | actual model × 0–2 lenses | decision counts | repaired, clean, or skipped | elapsed time |
| Repair verification | pre-repair → repaired head | actual model × 0–2 lenses | decision counts | final repair, clean, or skipped | elapsed time |
| Final gate | exact final head | deterministic | — | passed or failed | elapsed time |

Then include every finding with decision, impact, lenses, and artifact link; lens yield (unique and corroborated findings); autonomous assumptions; tests added or extended; deferred work; residual risk; any final repair left without fresh-eyes review; and total wall-clock duration from the scope comment to the report.

Then hand the merge decision to the human and stop unconditionally.
