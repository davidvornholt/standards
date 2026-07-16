---
name: review-fix
description: Use when the user asks for a review with fixes, a fix-what-review-finds pass over a PR, or a review loop. One bounded review → fix → verify cycle on a pull request.
---

# Review and fix

One bounded cycle over a pull request in a repo you control: one full review fan-out, dispositioned fixes, one verification pass over the fixes, then an unconditional stop and a residual-risk report.

There is deliberately no convergence condition. A capable reviewer instructed to find problems essentially never returns silence, so "review until clean" diverges: every fix enlarges the diff the next pass must clear, and the loop ends up reviewing its own output forever. Never add review passes beyond the two defined here.

This skill orchestrates the `review` skill. The PR is the only durable state: review threads are the findings ledger (unresolved threads block merge via the repository ruleset), the scope contract and report are PR comments, and the work is commits. Any session can resume by reading the PR.

## Roles

- **Orchestrator** (the invoking agent): PR setup, scope contract, lens selection, dispositions, thread posting, issue filing, gate runs, report. Never implements fixes.
- **`reviewer` subagents**: read-only finding and verification passes under the `review` skill contract.
- **Worker subagents**: consume unresolved review threads and push fix commits. A worker's inputs are the thread, the repository, and `.agents/review/decisions.md` — never the reviewer's reasoning. Threads must therefore be self-contained.

If subagent tooling is unavailable, stop and report that blocker.

## Setup

1. The cycle runs on a PR in a repo you control. For uncommitted work: commit on a feature branch, push, `gh pr create --draft`. For a third-party contribution: run the cycle on a PR inside your fork and open the upstream PR only after the report.
2. The cycle runs in its own git worktree — it owns that checkout for gate runs and worker commits. Remove the worktree when the cycle ends.
3. The PR is a **draft** while the cycle owns it; posting the report flips it to ready for review.
4. Run the deterministic gate (root `bun run check:fix`), fix and commit what it reports, BEFORE the review pass. Mechanical issues belong to the gate: it finds every instance at once; a reviewer finds a stochastic subset.
5. Read `.agents/review/decisions.md` (if present); pass its content to every reviewer.
6. Fixes are always new commits — never amend or force-push a branch under review (threads lose their anchors). Never arm auto-merge; merging stays a human decision.

## Scope contract

Before the review pass, post a PR comment that freezes the disposition yardstick — written before findings exist so it cannot bend to accommodate them:

- **Intent**: one paragraph — the problem this diff solves.
- **Threat model**: who runs the artifact, whose inputs it processes, and what breaking or leaking actually costs. Findings are judged for materiality against this, not against what is theoretically possible.
- **Lenses**: invented per diff with one-line charters (see the `review` skill's lens contract); include `catch-all` unless an unscoped reviewer runs, and always consider `premise` — a locally flawless change built on a wrong premise is the flaw diff-scoped lenses cannot see. A diff with database mutations and no data-integrity lens, or auth surfaces and no security lens, is a selection error.

**Split check**: several unrelated themes in one diff dilute every lens. Propose separate PRs and wait for explicit user approval before restructuring anything. An oversized coherent diff gets more, narrower lenses — not sharding, which hides cross-file findings.

## Review pass

One fan-out of reviewers over the FULL PR diff (branch vs base), run as the saved `review-pass` workflow:

```
Workflow({ name: 'review-pass', args: {
  baseRef: '<PR base branch>', gateStatus, decisions,
  lenses: [{ key, charter, notes }] } })
```

A non-empty `skippedLenses` is a partial fan-out: rerun those lenses before dispositioning. Without the Workflow tool, spawn `reviewer` subagents directly with identical pass semantics.

## Disposition

Every finding gets exactly one disposition, judged against the scope contract:

- **fix-now**: material under the threat model AND inside the intent. The bar: a maintainer would block the merge over it.
- **defer**: real but outside the intent or below materiality. File a self-contained GitHub issue — evidence, concrete failure scenario, suggested verification, link to the PR. Deferral is the default for real-but-adjacent findings; "reproducible" is not "material".
- **discard**: refuted, speculative, or conflicting with a registry decision. Append discards with durable value (deliberate policy or architecture choices, accepted risks) to `.agents/review/decisions.md`; summarize the rest in the review body.
- **needs-clarification**: pause and ask the user; apply the `needs-clarification` label (create it if missing) while paused.

Disposition a finding that is one instance of a repeated pattern as its class: the thread names the pattern and enumerates every sibling site, so the fix and the verification pass cover the class. The verification pass is delta-scoped and cannot see sibling defects the fix left untouched in the base diff — class-wide threads are what close that gap.

Escalation tripwires — each converts a fix-now into a user question, and a blanket pre-approval ("I approve all further decisions") does not lift them:

- the fix would add a new module, subsystem, or dependency;
- cumulative fix commits would exceed roughly half the original diff;
- the fix hardens beyond the stated threat model.

## Fix

Post one PR review for the pass: one line-anchored, self-contained thread per fix-now finding (evidence, failure scenario, suggested verification — the worker sees nothing else); findings with no diff line anchor to the nearest implicated line or go in the review body, tracked to closure by the orchestrator. Batch nits into one comment for a single fix round; summarize discards and deferrals in the review body.

Dispatch workers per unresolved thread (batch same-file threads; workers run sequentially unless their file sets are disjoint). Worker contract: reproduce the finding from the thread — if you cannot, reply in-thread with what you found and leave it unresolved (the orchestrator arbitrates). Otherwise fix, run the gate plus the thread's suggested verification, commit and push, reply with the verification evidence, and resolve the thread (GraphQL `resolveReviewThread`).

At disposition, tag each fix-now finding with a mechanization candidate (`biome-rule`, `axe-or-playwright`, `test`, `grit-plugin`, `none`); implement ratchets alongside the fixes in the same PR — native mechanisms first, covering the finding's class, not the instance. Ask before a ratchet that would force broad changes to unrelated code.

Re-run the deterministic gate after the fix round.

## Verification pass

One fresh `review-pass` fan-out scoped to the fixes: set `baseRef` to the pre-fix head SHA so the reviewed diff is exactly the fix commits, with lenses answering two questions — does each fix resolve its thread's finding, and did the fixes introduce regressions.

A fix that failed to resolve its thread's finding, or that introduced a regression, gets one repair round (worker, gate, evidence, thread reply). Everything else verification surfaces is dispositioned defer or discard — verification findings never start another review pass. Then stop, unconditionally.

## Report

Flip the PR from draft to ready for review and post the report: lens coverage, findings by disposition with counts, issues filed, ratchets implemented, verification result — including any repaired regressions and what remains unverified by fresh eyes — and residual risk. State the cycle's shape honestly ("one review fan-out over N lenses, one verification pass"), and hand what remains to the human: review the PR and decide the merge.
