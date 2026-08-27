---
name: review-fix
description: Use when the user asks for a review with fixes or a review loop. Runs one autonomous, bounded review → fix → verify cycle on a pull request, using one Luna Max reviewer per required pass and stopping unconditionally.
---

# Review and fix

Run one autonomous, bounded cycle over a pull request in a repository you control: establish scope, reuse or run one deterministic baseline gate, perform one full review, fix only merge blockers, verify the fix delta proportionally, optionally verify a high-risk repair, run one final gate, report, and stop.

There is deliberately no convergence condition. A reviewer instructed to keep searching can always enlarge the diff and review its own output forever. Never add passes beyond this contract, never start a new cycle for a finding produced by this cycle, and never run a fresh-eyes review after the final repair.

## Fixed review model

Every Codex review, fix-verification, and repair-verification pass uses the `reviewer` agent pinned to `gpt-5.6-luna` with `max` reasoning. Do not ask the user to choose a model, route a difficult concern to Sol, or mix models inside a cycle. If the harness cannot start the configured reviewer, report an execution blocker rather than turning model selection into a question.

Do not estimate or report token usage from the agent. Backend usage accounting is not observable reliably from the cycle. Duration comes from the timestamps of durable PR artifacts.

## Roles

- **Orchestrator**: owns PR setup, scope, the concern checklist, final decisions, GitHub artifacts, gate scheduling, and the report. It does not independently re-review the diff.
- **Reviewer**: one read-only `reviewer` agent per pass, covering every supplied concern in one traversal under the `review` skill.
- **Workers**: consume self-contained block threads and implement the smallest fixes. Batch compatible findings by owning surface; parallelize only disjoint file sets.

An independent reviewer is required for every pass this contract calls for. If worker subagents are unavailable, the orchestrator may implement already-decided fixes, but it must not replace an independent required review with self-review.

## Setup

1. Check whether the PR contains independent product themes. Do not pause merely because the diff is large or has several technical concerns. Ask about splitting only when the split changes the intended product outcome or merge plan; otherwise continue with one cycle and make the concern checklist explicit.
2. Run on a PR in a repository you control, in a dedicated worktree. Create a draft PR for uncommitted work. Never amend or force-push published review history.
3. Keep the PR draft while the cycle owns it. The final report marks it ready; an unavoidable `ask` keeps it draft.
4. Read `.agents/review/decisions.md` when present.
5. Post the scope contract before the baseline gate. Its GitHub timestamp is the cycle start.

## Scope contract

The scope comment freezes:

- **Intent**: the concrete outcome this diff is meant to deliver.
- **Threat model**: who runs it, whose inputs or data it handles, and what breakage, leakage, corruption, delay, or cost matters.
- **Concerns**: a compact checklist invented for this diff. Include premise and catch-all coverage in the same reviewer when useful; include data integrity for database mutations and security for authorization or credential surfaces.
- **Out of scope**: adjacent improvements that must not be pulled into the fix round.

A concern is a checklist for one reviewer, not an agent slot.

## Deterministic baseline

Use an already-successful exact-head required CI gate when it is equivalent to the repository's deterministic gate. Otherwise run the local deterministic gate once before review. Do not repeat an equivalent baseline locally and remotely.

Fix purely mechanical failures before the review only when they were introduced by the PR. Record a clearly base-preexisting failure instead of expanding scope to repair it.

## Review pass

Invoke one saved workflow over the full PR diff:

```text
Workflow({ name: 'review-pass', args: {
  passKind: 'review',
  baseRef: '<PR base branch>',
  gateStatus,
  decisions,
  intent,
  threatModel,
  concerns: [{ key, charter, notes }]
} })
```

Without the Workflow tool, spawn exactly one `reviewer` subagent with the same combined contract. A null, interrupted, or schema-invalid reviewer is a skipped pass and must be retried once; if it still cannot run, stop with the execution blocker.

The reviewer returns one final `decision` per finding: `block`, `defer`, `discard`, or `ask`, plus impact, evidence status, concern attribution, failure scenario, and suggested verification. There is no reviewer severity followed by a second disposition taxonomy. The orchestrator may correct a decision only by applying the frozen intent and threat model, and records the final decision directly.

## Autonomous decision policy

Continue without user input for implementation choices, reversible product details, naming or copy within established intent, test strategy inside existing infrastructure, local refactors, and adjacent machinery that can be deferred.

Use `ask` only when all of these hold:

1. At least two materially different product or architecture outcomes remain plausible.
2. The request, PR, decisions registry, tests, and existing architecture do not choose between them.
3. Choosing wrongly would be expensive to reverse because it changes a durable data or wire contract, broad ownership or lifecycle boundary, externally visible product semantics, or foundational architecture.

A new dependency or subsystem is not automatically a question. Prefer a smaller fix or `defer`. Ask only when the current PR cannot be made safe without choosing that architecture.

Collect every unavoidable question discovered in the pass into one decision brief and one pause. State the current behavior, options and consequences, and one recommendation. Post it as a PR comment, apply `needs-clarification`, and keep the PR draft. Do not ask one question at a time.

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

Review only the fix commits, with `baseRef` equal to the pre-fix head. Invoke one combined reviewer, not a concern fan-out, and ask two questions: did each block close, and did the fix introduce a material regression?

Skip fresh-eyes fix verification and use focused mechanical checks only when the delta changes exclusively:

- Markdown prose, comments, or static copy; or
- isolated tests that do not change global mocks, shared fixtures, schemas, workflows, seeded data, or test infrastructure.

Any runtime code, configuration, workflow, migration, shared fixture, global mock, or behavioral UI change receives one Luna Max fix-verification pass. An issue reproducible on the pass base predates the fix and becomes `defer` or `discard`; only a defect introduced by the fix can trigger repair.

## Repair round

One worker batch repairs unresolved blocks or fix-introduced regressions. Use focused checks, not another full gate.

Run one fresh repair-verification pass only when the repair touches a high-risk invariant:

- authentication, authorization, tenant isolation, credentials, or secrets;
- persistence, migrations, destructive data paths, or recovery;
- concurrency, revisions, idempotency, retries, or transaction boundaries;
- cache identity or reuse across requests, users, jobs, or persisted resumes;
- deployment artifact identity, provenance, or promotion;
- untrusted external, AI, or tool output crossing an authoritative or persisted boundary.

For any other repair delta, the reproducer and focused checks are the verification. If the high-risk repair review finds a material defect, make one final repair and verify it mechanically. Do not run another reviewer and do not start another cycle.

## Final deterministic gate

After the last code change, run the full deterministic gate exactly once. If no code changed and the exact reviewed head already had a successful equivalent gate, reuse it.

A gate failure caused by the cycle receives a mechanical fix and a rerun. This does not authorize another review pass. A base-preexisting failure remains explicit residual risk.

After the required review and final gate succeed, post verification replies and resolve the block threads.

## Report

Post the report, then mark the PR ready for human review. Its GitHub timestamp is the cycle end. Do not claim token counts.

Open with a phase table:

| Phase | Scope | Reviewer | Decisions | Outcome | Artifact |
| --- | --- | --- | --- | --- | --- |
| Baseline gate | exact initial head | deterministic | — | reused or run | check/run |
| Review | base → initial head | Luna Max, one reviewer | block/defer/discard/ask counts | fix round or clean | review |
| Fix verification | pre-fix → fixed head | Luna Max, one reviewer or mechanically skipped | counts | repaired or clean | review/check |
| Repair verification | pre-repair → repaired head | Luna Max, one reviewer or risk-skipped | counts | final repair or clean | review/check |
| Final gate | exact final head | deterministic | — | pass/fail | check/run |

Every defined phase appears, including skipped phases with the reason. Artifact timestamps define the phase windows; calculate total wall-clock time from the scope comment to this report and distinguish waiting from active work when the record shows it.

Below the table include:

- one-line finding index entries with decision, impact, concerns, and artifact link;
- autonomous decisions and the assumptions behind them;
- tests added or extended, which failure class each protects, and whether any new test mechanism was introduced;
- deferred work and residual risk;
- whether a final repair was mechanically verified without fresh eyes;
- the honest cycle shape: one full reviewer, zero or one fix verifier, zero or one high-risk repair verifier.

Then hand the merge decision to the human. Stop unconditionally.
