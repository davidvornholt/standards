---
name: review-fix
description: Use when asked to review a pull request and fix its findings in the same review loop. Runs one bounded review, repair, and verification cycle.
---

# Review and fix

Run one bounded cycle: establish the baseline, review the initial diff, fix merge blockers, verify the fix delta, run the final gate, report, and stop. Use a draft PR in a dedicated worktree and add new commits only. Never review until clean, start another cycle for findings created by this cycle, or fresh-review the final repair.

## Model

An explicit user choice wins. Otherwise use Claude Opus 5 at high effort in Claude Code, GPT-5.6 Luna at max effort in a GPT-capable harness, or the current model when neither is available. Use the same model for every lens. Never silently replace an explicitly requested model; report an execution blocker if it cannot run.

## Scope

Read `.agents/review/decisions.md` when present. Post one scope comment with the intent, threat model, out-of-scope work, and selected lenses; its timestamp starts the cycle. Ask about splitting only when the PR contains independent product outcomes.

Choose distinct lenses:

| Diff | Lenses |
| --- | ---: |
| Prose or static copy only | 1 |
| Ordinary behavior or configuration | 2 |
| One high-risk family or large cross-system change | 3 |
| Several independent high-risk families | 4 maximum |

The default pair is:

1. **Behavior and invariants:** correctness, error paths, state transitions, edge cases, and meaningful tests.
2. **Premise and integration:** whether the change solves the stated problem and preserves architecture, compatibility, and operational contracts; it owns otherwise unassigned material findings.

Add a specialized lens only when a material risk such as authorization, persistence, concurrency, deployment provenance, untrusted output, or complex accessibility otherwise lacks an owner. Give every lens explicit exclusions. Every lens after the second must name the material failure class that would otherwise lack an owner.

## Baseline and review

Reuse a successful equivalent exact-head gate. Otherwise run the repository gate once. Repair only PR-introduced mechanical failures before review and record pre-existing failures.

Run `review-pass` over the PR base → initial head with the scope, gate result, decisions registry, lenses, and any model override. Retry a skipped lens once, then stop if coverage is still incomplete. Merge duplicate findings while preserving every reporting lens, and assign one decision:

- `block`: demonstrated, in scope, material under the threat model, and worth stopping the merge;
- `defer`: real but outside this PR or below the merge bar;
- `discard`: refuted, speculative, already accepted, or not worth scheduling;
- `ask`: a costly, durable product or architecture choice remains unresolved.

Do not ask about inferable implementation details, naming, local refactors, test shape, or other reversible choices. Choose the smallest sound option and record durable assumptions. Collect every unavoidable `ask` into one decision brief with the options, consequences, and a recommendation.

## Fix

Create one self-contained review thread per blocker. A worker reproduces the failure first, makes the smallest correction, and runs focused checks. If it cannot reproduce the failure, leave the thread unresolved and reclassify the finding instead of fixing it speculatively.

Add at most one regression test per failure class, preferably by extending existing or table-driven coverage. The test should fail on the pre-fix behavior when practical. Do not add a dependency, parser, fixture framework, generic harness, or shared guard for one finding. Use browser tests only for browser-specific behavior.

Keep blocker threads unresolved until their required verification and the final gate pass.

## Verify

Review only the fix commits. Skip fresh review for prose or static-copy changes and isolated tests that do not alter shared fixtures, schemas, workflows, seeded or generated data, global mocks, or test infrastructure. Otherwise use one targeted lens, or two only for two independent invariant families.

Only an unresolved original blocker or a defect introduced by the fix may trigger one repair round; pre-existing defects are deferred or discarded. Fresh-review the repair only when it touches secrets or authorization, persistence or migrations, recovery, concurrency, retries, transaction boundaries, cache identity, artifact provenance, or untrusted output crossing an authoritative or persisted boundary. Use one targeted lens, or two only for two independent invariant families.

If repair verification finds a material defect, make one final repair, verify it mechanically only, and stop. Run the full deterministic gate once after the last change. Fix cycle-introduced gate failures mechanically without starting another review pass, then resolve blocker threads after verification and the final gate pass.

## Report and stop

Post the report and mark the PR ready unless an `ask` remains. Include every phase, including skipped phases, and open with:

| Phase | Scope | Model / lenses | Findings | Outcome | Duration |
| --- | --- | --- | --- | --- | ---: |
| Baseline gate | exact initial head | deterministic | — | reused or passed | elapsed |
| Review | base → initial head | model × lenses | decision counts | fixed or clean | elapsed |
| Fix verification | fix delta | model × 0–2 lenses | decision counts | repaired, clean, or skipped | elapsed |
| Repair verification | repair delta | model × 0–2 lenses | decision counts | final repair, clean, or skipped | elapsed |
| Final gate | exact final head | deterministic | — | passed or failed | elapsed |

Then link each finding with its decision, impact, and reporting lenses; report lens yield, assumptions, tests added or extended, any new test machinery, deferred work, residual risk, and any final repair left without fresh-eyes review. Measure total wall-clock duration from the scope comment to the report.

Hand the merge decision to the human and stop unconditionally.
