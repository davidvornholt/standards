---
name: review-fix
description: Use when the user asks for a review with fixes or a review loop. Runs one autonomous, bounded review → fix → verify cycle on a pull request, using a small adaptive Luna Max lens fan-out and stopping unconditionally.
---

# Review and fix

Run one autonomous, bounded cycle over a pull request in a repository you control: establish scope, reuse or run one deterministic baseline gate, perform one bounded lens fan-out, fix only merge blockers, verify the fix delta proportionally, optionally verify a high-risk repair, run one final gate, report, and stop.

There is deliberately no convergence condition. A reviewer instructed to keep searching can always enlarge the diff and review its own output forever. Never add passes beyond this contract, never start a new cycle for a finding produced by this cycle, and never run a fresh-eyes review after the final repair.

## Fixed model, adaptive attention

Every Codex review, fix-verification, and repair-verification agent uses the `reviewer` profile pinned to `gpt-5.6-luna` with `max` reasoning. Do not ask the user to choose a model, route a difficult lens to Sol, or mix models inside a cycle.

The number of reviewers is adaptive. Separate lens agents are deliberate: independent attention budgets find defects that one broad reviewer can miss. The fan-out is still bounded because overlapping lenses reread the same context without owning a distinct failure class.

Do not estimate or report token usage from the agent. Backend usage accounting is not observable reliably from the cycle. Duration comes from the timestamps of durable PR artifacts.

## Roles

- **Orchestrator**: owns PR setup, scope, lens selection, final decisions, GitHub artifacts, gate scheduling, and the report. It does not independently re-review the diff.
- **Reviewers**: one read-only `reviewer` agent per selected lens. Every reviewer reads the full diff but reports only its lens.
- **Workers**: consume self-contained block threads and implement the smallest fixes. Batch compatible findings by owning surface; parallelize only disjoint file sets.

Independent reviewers are required for every fan-out this contract calls for. If worker subagents are unavailable, the orchestrator may implement already-decided fixes, but it must not replace a required independent review with self-review.

## Setup

1. Check whether the PR contains independent product themes. Do not pause merely because the diff is large or has several technical concerns. Ask about splitting only when the split changes the intended product outcome or merge plan; otherwise continue with one cycle and make the lenses explicit.
2. Run on a PR in a repository you control, in a dedicated worktree. Create a draft PR for uncommitted work. Never amend or force-push published review history.
3. Keep the PR draft while the cycle owns it. The final report marks it ready; an unavoidable `ask` keeps it draft.
4. Read `.agents/review/decisions.md` when present.
5. Post the scope contract before the baseline gate. Its GitHub timestamp is the cycle start.

## Scope contract and lens economy

The scope comment freezes:

- **Intent**: the concrete outcome this diff is meant to deliver.
- **Threat model**: who runs it, whose inputs or data it handles, and what breakage, leakage, corruption, delay, or cost matters.
- **Lenses**: non-overlapping reviewer charters selected by the policy below, including explicit exclusions.
- **Out of scope**: adjacent improvements that must not be pulled into the fix round.

A lens earns a reviewer slot only when removing it would leave a named material failure class without a primary owner. Merge lenses that would inspect the same surfaces for the same kind of failure. Tests, documentation, naming, style, architecture, and maintainability are not automatic standalone lenses; fold them into the behavioral or risk lens whose invariant they support. Premise and catch-all normally share one integration lens rather than consuming two slots.

Use this bounded scale for the full review:

| Diff shape | Lenses |
| --- | ---: |
| Markdown, comments, or static copy only | 1 |
| Ordinary behavioral code or configuration | 2 |
| One independently high-risk family or a large cross-subsystem change | 3 |
| Several genuinely independent high-risk families | 4 maximum |

For ordinary behavioral changes, the default pair is:

1. **Behavior and invariants** — correctness, error paths, edge cases, state transitions, and whether tests protect the claimed behavior.
2. **Premise and integration** — whether the change solves the right problem and preserves cross-file, architecture, compatibility, operational, and otherwise unowned material contracts; this lens carries catch-all responsibility.

Add a specialized lens only for an independently high-risk family such as authorization, data integrity/concurrency, deployment provenance, untrusted external or AI output, or interaction/accessibility when that family is central to the diff. A specialized lens may replace part of a default charter instead of always adding another agent.

Every lens after the second needs a one-line justification in the scope comment naming the failure class that would otherwise lack a primary owner. Four is a hard cap. If five lenses appear necessary, merge overlapping charters or revisit whether the PR contains independent product themes.

## Deterministic baseline

Use an already-successful exact-head required CI gate when it is equivalent to the repository's deterministic gate. Otherwise run the local deterministic gate once before review. Do not repeat an equivalent baseline locally and remotely.

Fix purely mechanical failures before the review only when they were introduced by the PR. Record a clearly base-preexisting failure instead of expanding scope to repair it.

## Review pass

Invoke the saved workflow over the full PR diff:

```text
Workflow({ name: 'review-pass', args: {
  passKind: 'review',
  baseRef: '<PR base branch>',
  gateStatus,
  decisions,
  intent,
  threatModel,
  lenses: [{ key, charter, exclusions, notes }]
} })
```

Without the Workflow tool, spawn one `reviewer` subagent per lens in parallel with the same contracts. A non-empty `skippedLenses` result is a partial fan-out: retry only those lenses once. If any still cannot run, stop with the execution blocker rather than silently accepting reduced coverage.

Each merged finding has one final `decision`: `block`, `defer`, `discard`, or `ask`, plus impact, evidence status, lens attribution, failure scenario, and suggested verification. There is no reviewer severity followed by a second disposition taxonomy. When several lenses independently report the same finding, preserve every lens attribution and merge the duplicate before creating work.

## Autonomous decision policy

Continue without user input for implementation choices, reversible product details, naming or copy within established intent, test strategy inside existing infrastructure, local refactors, and adjacent machinery that can be deferred.

Use `ask` only when all of these hold:

1. At least two materially different product or architecture outcomes remain plausible.
2. The request, PR, decisions registry, tests, and existing architecture do not choose between them.
3. Choosing wrongly would be expensive to reverse because it changes a durable data or wire contract, broad ownership or lifecycle boundary, externally visible product semantics, or foundational architecture.

A new dependency or subsystem is not automatically a question. Prefer a smaller fix or `defer`. Ask only when the current PR cannot be made safe without choosing that architecture.

Collect every unavoidable question discovered across the fan-out into one decision brief and one pause. State the current behavior, options and consequences, and one recommendation. Post it as a PR comment, apply `needs-clarification`, and keep the PR draft. Do not ask one question at a time.

For a reversible ambiguity below this bar, choose the simplest in-scope behavior, record the assumption in `.agents/review/decisions.md` when it has durable value, and list it under autonomous decisions in the report.

## Decision handling

- **block**: create one self-contained review thread. It must include evidence, the concrete failure scenario, and the minimal suggested verification. Only block threads enter the current fix round.
- **defer**: keep it out of this PR. File a `deferred-finding` issue only when the work is concrete and plausible to schedule; otherwise use `discard` rather than creating backlog noise.
- **discard**: summarize only durable reasoning or accepted risk. Append a registry entry when it prevents the concern from recurring.
- **ask**: follow the single-pause policy above.

Treat repeated instances as one failure class. The thread names the invariant and every known sibling site so one fix and one test close the class.

## Fix round

Post one PR review containing the block threads, then dispatch the smallest sensible worker batches. A worker first reproduces the failure against the pre-fix head. If it cannot, it leaves the thread unresolved with its evidence for the orchestrator to change to `defer` or `discard`.

The fix contract is deliberately parsimonious:

- Prefer deletion, narrowing, and established repository mechanisms over new abstraction or enforcement machinery.
- Run focused checks for the touched surface after each worker batch. Do not run the full repository gate per thread or worker.
- Add at most one minimal regression test per failure class, preferably by extending an existing test or using one table-driven case set.
- A new test must protect behavior that would have failed on the pre-fix head; demonstrate that with the old commit, a temporary worktree, or a direct mutation/probe when practical.
- Do not add a new dependency, fixture framework, parser, generic harness, guard subsystem, or shared test mechanism for one finding. Use the existing mechanism, make the local fix, or defer the broader machinery.
- Do not add tests for trivial copy, static literals, type-impossible states, or examples already covered by a stronger behavioral test.
- Browser tests are reserved for browser-specific behavior. Keep pure mappings, parsing, filenames, and payloads in fast tests.

Mechanization is optional, not a tax on every finding. Add a native rule or small class-wide ratchet only when it is cheaper to maintain than repeating the review. `none` is normal.

Do not resolve block threads yet. The final gate and required verification must succeed first.

## Fix verification

Review only the fix commits, with `baseRef` equal to the pre-fix head, and ask two questions: did each block close, and did the fix introduce a material regression?

Skip fresh-eyes fix verification and use focused mechanical checks only when the delta changes exclusively:

- Markdown prose, comments, or static copy; or
- isolated tests that do not change global mocks, shared fixtures, schemas, workflows, seeded data, or test infrastructure.

For every other delta, use one targeted Luna Max lens by default. Use two lenses only when the fix delta spans two independent invariant families that cannot be covered responsibly by one charter; two is the hard cap. Do not add a generic catch-all verification lens merely because the delta contains code.

Invoke `review-pass` with `passKind: 'fix-verification'`, the pre-fix head as `baseRef`, and one or two delta-specific lenses. A defect reproducible on the pass base predates the fix and becomes `defer` or `discard`; only a defect introduced by the fix or an unresolved original block can trigger repair.

## Repair round

One worker batch repairs unresolved blocks or fix-introduced regressions. Use focused checks, not another full gate.

Run fresh repair verification only when the repair touches a high-risk invariant:

- authentication, authorization, tenant isolation, credentials, or secrets;
- persistence, migrations, destructive data paths, or recovery;
- concurrency, revisions, idempotency, retries, or transaction boundaries;
- cache identity or reuse across requests, users, jobs, or persisted resumes;
- deployment artifact identity, provenance, or promotion;
- untrusted external, AI, or tool output crossing an authoritative or persisted boundary.

Use one targeted Luna Max lens for the usual repair delta. A second lens is allowed only when the repair independently spans two high-risk families; two is the hard cap. For any other repair delta, the reproducer and focused checks are the verification.

If repair verification finds a material defect, make one final repair and verify it mechanically. Do not run another reviewer and do not start another cycle.

## Final deterministic gate

After the last code change, run the full deterministic gate exactly once. If no code changed and the exact reviewed head already had a successful equivalent gate, reuse it.

A gate failure caused by the cycle receives a mechanical fix and a rerun. This does not authorize another review pass. A base-preexisting failure remains explicit residual risk.

After the required review and final gate succeed, post verification replies and resolve the block threads.

## Report

Post the report, then mark the PR ready for human review. Its GitHub timestamp is the cycle end. Do not claim token counts.

Open with a phase table:

| Phase | Scope | Reviewers | Decisions | Outcome | Artifact |
| --- | --- | --- | --- | --- | --- |
| Baseline gate | exact initial head | deterministic | — | reused or run | check/run |
| Review | base → initial head | Luna Max × lens count | block/defer/discard/ask counts | fix round or clean | reviews |
| Fix verification | pre-fix → fixed head | Luna Max × 0–2 lenses | counts | repaired, clean, or mechanically skipped | reviews/check |
| Repair verification | pre-repair → repaired head | Luna Max × 0–2 lenses | counts | final repair, clean, or risk-skipped | reviews/check |
| Final gate | exact final head | deterministic | — | pass/fail | check/run |

Every defined phase appears, including skipped phases with the reason. Artifact timestamps define the phase windows; calculate total wall-clock time from the scope comment to this report and distinguish waiting from active work when the record shows it.

Below the table include:

- one-line finding index entries with decision, impact, every reporting lens, and artifact link;
- lens yield: findings unique to each lens and findings corroborated across lenses;
- autonomous decisions and the assumptions behind them;
- tests added or extended, which failure class each protects, and whether any new test mechanism was introduced;
- deferred work and residual risk;
- whether a final repair was mechanically verified without fresh eyes;
- the honest cycle shape: full-review lens count, fix-verification lens count, and repair-verification lens count.

Then hand the merge decision to the human. Stop unconditionally.
