---
name: review-fix
description: Use when the user asks for a review with fixes, a fix-what-review-finds pass over a PR, or a review loop. One bounded review → fix → verify cycle on a pull request.
---

# Review and fix

One bounded cycle over a pull request in a repo you control: one full review fan-out, dispositioned fixes, delta-scoped verification of the fixes and of any repairs, then an unconditional stop and a residual-risk report.

There is deliberately no convergence condition. A capable reviewer instructed to find problems essentially never returns silence, so "review until clean" diverges: every fix enlarges the diff the next pass must clear, and the loop ends up reviewing its own output forever. Never add review passes beyond those defined here.

This skill orchestrates the `review` skill. The PR is the only durable state: review threads are the findings ledger (unresolved threads block merge via the repository ruleset), the scope contract and report are PR comments, and the work is commits. Any session can resume by reading the PR.

## Roles

- **Orchestrator** (the invoking agent): PR setup, scope contract, lens selection, dispositions, thread posting, issue filing, gate runs, report. Never implements fixes.
- **`reviewer` subagents**: read-only finding and verification passes under the `review` skill contract.
- **Worker subagents**: consume unresolved review threads and push fix commits. A worker's inputs are the thread, the repository, and `.agents/review/decisions.md` — never the reviewer's reasoning. Threads must therefore be self-contained.

If subagent tooling is unavailable, stop and report that blocker.

## Setup

1. **Split check**: several unrelated themes in one diff dilute every lens. Check at the earliest moment the diff exists — for uncommitted work before creating the PR, for an existing PR before investing further. Propose separate PRs and wait for explicit user approval before restructuring anything. An oversized coherent diff gets more, narrower lenses — not sharding, which hides cross-file findings.
2. The cycle runs on a PR in a repo you control. For uncommitted work: commit on a feature branch, push, `gh pr create --draft`. For a third-party contribution: run the cycle on a PR inside your fork and open the upstream PR only after the report.
3. The cycle runs in its own git worktree — it owns that checkout for gate runs and worker commits. Remove the worktree when the cycle ends.
4. The PR is a draft while the cycle owns it; posting the report flips it to ready for review.
5. Run the deterministic gate, fix and commit what it reports, BEFORE the review pass. Mechanical issues belong to the gate: it finds every instance at once; a reviewer finds a stochastic subset.
6. Read `.agents/review/decisions.md` (if present); pass its content to every reviewer.

## Scope contract

Before the review pass, post a PR comment that freezes the disposition yardstick.

- **Intent**: one paragraph — the problem this diff solves.
- **Threat model**: who runs the artifact, whose inputs it processes, and what breaking or leaking actually costs. Findings are judged for materiality against this, not against what is theoretically possible.
- **Lenses**: invented per diff with one-line charters (see the `review` skill's lens contract); include `catch-all` unless an unscoped reviewer runs, and always consider `premise` — a locally flawless change built on a wrong premise is the flaw diff-scoped lenses cannot see. A diff with database mutations and no data-integrity lens, or auth surfaces and no security lens, is a selection error.

## Review pass

One fan-out of reviewers over the FULL PR diff (branch vs base), run as the saved `review-pass` workflow:

```
Workflow({ name: 'review-pass', args: {
  baseRef: '<PR base branch>', gateStatus, decisions,
  lenses: [{ key, charter, notes }] } })
```

A non-empty `skippedLenses` is a partial fan-out: rerun those lenses before dispositioning. Without the Workflow tool, spawn `reviewer` subagents directly with identical pass semantics.

## Disposition

Every finding gets exactly one disposition, judged against the scope contract. A finding's `unverified` observation routes it: a human intent question → needs-clarification; an external observation → defer, with that observation as the issue's suggested verification.

- **fix-now**: material under the threat model AND inside the intent. The bar: a maintainer would block the merge over it.
- **defer**: real but outside the intent or below materiality. File a self-contained GitHub issue — evidence, concrete failure scenario, suggested verification, link to the PR — labeled `deferred-finding`. Deferral is the default for real-but-adjacent findings; "reproducible" is not "material".
- **discard**: refuted, speculative, or conflicting with a registry decision. Append discards with durable value (deliberate policy or architecture choices, accepted risks) to `.agents/review/decisions.md`; each entry records the premise of the acceptance (why the risk was acceptable), since premise drift is what re-opens it. Summarize the rest in the review body.
- **needs-clarification**: pause and ask the user, with a decision brief per question: what the diff currently does, each option's concrete consequences (who breaks, what it costs), and a recommendation with reasoning.

Every pause for user input — needs-clarification and tripwires alike — is posted as a PR comment carrying the decision brief, and applies the `needs-clarification` label. While a live session waits for the answer, watch the thread with a harness monitor facility if one exists. Otherwise, keep the current turn open and poll `gh` with generous backoff until an answer arrives or it times out.

Disposition a finding that is one instance of a repeated pattern as its class: the thread names the pattern and enumerates every sibling site, so the fix and the verification pass cover the class. The verification pass is delta-scoped and cannot see sibling defects the fix left untouched in the base diff — class-wide threads are what close that gap.

## Escalation tripwires

Each tripwire converts a fix-now into a user question, and a blanket pre-approval does not lift them:

- the fix would introduce production machinery with invariants of its own — machinery that would deserve a review lens the scope contract never included. A new dependency always qualifies; so does a subsystem or mechanism of any kind (a pool, a state machine, a retry layer, a background fiber — the examples are illustrative, the lens test is the trigger);
- the fix hardens beyond the stated threat model.

New tests are never a tripwire, and neither is mechanically splitting a file the fix pushed over the line limit: a fix that only reworks code the lens set already covers stays inside the contract no matter how many lines it touches. Size never trips the wire; only new machinery does. Tripwires bind fixes as well as dispositions: a worker whose fix would cross one stops, replies in-thread naming the boundary, and leaves the thread unresolved for the orchestrator to escalate.

## Fix

Post one PR review for the pass: one line-anchored, self-contained thread per fix-now finding (evidence, failure scenario, suggested verification — the worker sees nothing else); findings with no diff line anchor to the nearest implicated line or go in the review body, tracked to closure by the orchestrator. Batch nits into one comment for a single fix round; summarize discards and deferrals in the review body.

Fixes are always new commits — never amend or force-push a branch under review (threads lose their anchors). Dispatch workers per unresolved thread (batch same-file threads; workers run sequentially unless their file sets are disjoint). Worker contract: reproduce the finding from the thread — if you cannot, reply in-thread with what you found and leave it unresolved (the orchestrator arbitrates). Otherwise fix, run the gate plus the thread's suggested verification, commit and push, reply with the verification evidence, and resolve the thread (GraphQL `resolveReviewThread`).

At disposition, tag each fix-now finding with a mechanization candidate (`biome-rule`, `axe-or-playwright`, `test`, `grit-plugin`, `none`); implement ratchets alongside the fixes in the same PR — native mechanisms first, covering the finding's class, not the instance. Ask before a ratchet that would force broad changes to unrelated code.

Re-run the deterministic gate after the fix round.

## Verification pass

One fresh `review-pass` fan-out scoped to the fixes: set `baseRef` to the pre-fix head SHA so the reviewed diff is exactly the fix commits, with lenses answering two questions — does each fix resolve its thread's finding, and did the fixes introduce regressions. Verifiers attack the class, not the instance: reconstruct each failure mode with real inputs through the real pipeline, and actively construct sibling inputs that still exhibit the class the fix claims to close.

Scale each verification fan-out to its delta, not to the PR: a delta touching only Markdown prose or code comments gets one combined lens; a delta touching anything else — code, configuration, workflows, tests — keeps a multi-lens fan-out. The classification is the delta's file list, not a judgment call, and it errs conservative: seeded files and workflow YAML count as behavior. Fix rounds introduce regressions where they touch behavior, not prose — depth belongs where the fix commits put it.

A fix that failed to resolve its thread's finding, or that introduced a regression, gets one repair round (worker, gate, evidence, thread reply). "Introduced" is a mechanical test, not a judgment call: a defect reproducible on the pass's base SHA predates the fixes and is deferred, however real — only defects the reviewed commits created qualify for repair. If a repair round ran, one further `review-pass` scoped to the repair delta only (baseRef = the pre-repair head) checks the repairs the same way; anything material it finds gets one final repair, verified mechanically only. Everything else verification surfaces is dispositioned defer or discard — verification findings never start a full review pass. Then stop, unconditionally. The final repair alone remains unverified by fresh eyes; name that in the report.

## Report

Flip the PR from draft to ready for review and post the report. It opens with a pass table — one row per pass this skill defines (review fan-out, fix verification, repair verification), in cycle order:

| Pass | Scope | Lenses | fix-now | defer | discard | Outcome | Details |
| --- | --- | --- | --- | --- | --- | --- | --- |

- Every defined pass gets a row even when it did not run — mark it explicitly with the reason.
- Scope is the pass's reviewed range (baseRef → head SHA). Outcome names what the pass produced: threads fixed, repairs triggered, mechanical-only verification.
- Details links to the artifact carrying the pass's output — its posted PR review, or the threads and comments holding its findings. The table carries counts and provenance; evidence stays in the linked artifacts.

Below the table, a finding index: one line per finding — short title, originating pass, disposition, impact tag, and a link to its review thread, filed issue, or `.agents/review/decisions.md` entry. The impact tag records blast radius, which disposition does not: `breakage` (behavior would be wrong or broken), `weakening` (a guarantee, policy, or gate silently loses force), or `polish` (wording, naming, coverage). Impact tags are what let later analysis measure which passes catch what, so tag against the finding's consequence, not its fix size. Do not restate evidence or reasoning in the index; the linked artifact is the ledger.

The rest stays prose: ratchets implemented, residual risk, any repaired regressions and what remains unverified by fresh eyes, and an honest cycle-shape statement ("one review fan-out over N lenses, one verification pass"). Then hand what remains to the human: review the PR and decide the merge.
