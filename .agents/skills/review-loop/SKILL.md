---
name: review-loop
description: Use when the user asks for a review loop, review pass with fixes, or to keep fixing until review is clean. Runs against a pull request in a repo you control; findings live as PR review threads, fixes land as commits from thread-consuming workers, and broad diffs split into a stacked PR train. All agents run locally, never in CI.
---

# Review loop

Repeated review/fix passes over a pull request until convergence is evidenced, not asserted. The PR is the only durable state: its diff is the work under review, review threads are the findings ledger (unresolved threads block merge via the repository ruleset), pass summaries are PR comments, and the loop's own work is its commits. Any session can resume by reading the PR — there is no local ledger.

This skill orchestrates the `review` skill. Every agent runs locally; nothing runs in CI.

## Roles

- **Orchestrator** (the invoking agent): PR setup, split gate, lens selection, dispositions, thread posting, convergence accounting, gate runs, final report. Never implements fixes.
- **`reviewer` subagents**: read-only finding and verification passes under the `review` skill contract.
- **Worker subagents**: consume unresolved review threads and push fix commits. A worker's inputs are the thread, the repository, and `.agents/review/decisions.md` — never the reviewer's reasoning. Threads must therefore be self-contained.

If subagent tooling is unavailable, stop and report that blocker; do not substitute a local-only review.

## PR setup

1. The loop runs on a PR in a repo you control. For uncommitted work: commit via the `git-commit` skill on a feature branch, push, `gh pr create`. For a third-party contribution: run the loop on a PR inside your fork and open the upstream PR only after convergence — upstream sees one clean artifact, the review dialogue stays in your fork.
2. Run the deterministic gate (root `bun run check:fix`), fix and commit what it reports, BEFORE any review pass. Mechanical issues belong to the gate: it finds every instance at once; a reviewer finds a stochastic subset per pass.
3. Read `.agents/review/decisions.md` (if present); pass its content to every reviewer.
4. Fixes are always new commits — never amend or force-push a branch under review (threads lose their anchors), except the restack step below. Never arm auto-merge; merging stays a human decision.

## Split gate → stacked PRs

When the diff contains several unrelated changes, one review pass dilutes attention across content no single finding can span. Vocabulary: a **theme** is one commit subject's worth of intent; **coupling** edges in decreasing strength are an interleaved file, a code dependency, a shared artifact, and semantic coupling (shared runtime behavior, no shared text); a **cluster** is a connected component under coupling edges — the smallest unit reviewable in isolation, never shard below it.

1. Delegate the theme/coupling/cluster mapping to a subagent. Split only when no file carries hunks of two clusters; a single cluster or a trivially small diff skips the gate.
2. Propose the split as an ordered branch-and-PR plan and wait for explicit user approval before restructuring anything.
3. Build the stack in dependency order — one branch per cluster, each based on its parent, committed via `git-commit` — push, and open every PR immediately with its parent branch as base, so each PR shows exactly its cluster and CI runs from minute one.
4. The deterministic gate must pass per cluster in isolation. A failure the combined diff did not have is hidden coupling: merge those clusters and re-plan; do not patch around it.
5. Review in convergence-gated order: run the full loop on PR 1; when it *converges* (dry counter — not when it merges), restack its child onto the converged head and start the child's loop while PR 1 awaits human merge. Clusters in disjoint stacks loop in parallel.
6. Restack after each squash merge: branch deletion auto-retargets the child PR to main; rebase the child (`git rebase --onto main <merged-branch-head>`) and force-push. Threads survive as "outdated" and stay merge-blocking.
7. Seam check, proportional to residual risk: file-disjoint, independently gate-clean clusters with no shared runtime skip it (record that evidence in the PR); a shared surface (config, docs spanning clusters, cross-cluster naming) gets one reviewer over exactly that surface; only a judgment-based hunk assignment earns a catch-all pass over the combined diff.

## Passes

Invent the lens set per diff with one-line charters (see the `review` skill's lens contract); include `catch-all` unless an unscoped reviewer runs. A diff with database mutations and no data-integrity lens, or auth surfaces and no security lens, is a selection error. Post the lens set and justification as a PR comment before pass 1.

A pass is one fan-out of reviewers over the FULL PR diff (branch vs base) — never over just the latest fix delta. Run it as the saved `review-pass` workflow:

```
Workflow({ name: 'review-pass', args: {
  passNumber, baseRef: '<PR base branch>', gateStatus,
  decisions, lenses: [{ key, charter, notes }] } })
```

It fans out one reviewer per lens with schema-enforced findings, pipelines risky findings through refutation, dedupes across lens seams, and returns a merged severity-ordered set plus `skippedLenses` — a dead reviewer reads as a partial fan-out, not a clean pass. Without the Workflow tool, spawn `reviewer` subagents directly with the same thin contract; pass semantics must be identical.

Then, per pass:

1. **Disposition** every finding against evidence, repo contracts, and the registry: to-fix, discarded (with reason), or needs-clarification (pause and ask the user). Never blindly implement speculative, duplicate, or out-of-scope findings — this filter is what keeps false positives from costing worker spawns and damaging code.
2. **Post one PR review for the pass**: one line-anchored thread per to-fix finding, self-contained (evidence, concrete failure scenario, suggested verification) because the worker sees nothing else. Findings with no diff line (missing files, architecture) anchor to the nearest implicated line, or go in the review body — the orchestrator tracks those to closure itself, since thread-resolution enforcement cannot. Batch nits into one comment for a single end-of-loop fix round. Summarize discards in the review body, not as threads.
3. **Fix**: poll unresolved threads and dispatch workers. Batch same-file threads into one worker; run workers in parallel only on disjoint file sets. Worker contract: reproduce the finding from the thread — if you cannot, reply in-thread with what you found and leave it unresolved (that disagreement is a free re-verification; the orchestrator arbitrates). Otherwise fix, run the gate plus the thread's suggested verification, commit and push, reply with the verification evidence, and resolve the thread (GraphQL `resolveReviewThread`).
4. **Gate and record**: re-run the deterministic gate, then post a pass-summary comment: lenses run, findings by disposition, dry-counter value.

## Stopping rule

Track a dry counter of consecutive FULL fan-outs (all selected lenses, fresh contexts) with zero new confirmed blocking or non-blocking findings; the loop converges at 2 — one clean pass is a sample, not proof. New confirmed findings reset it; nits, refutations, and discards do not. Intermediate passes may re-sample only previously-hot lenses plus `catch-all`, but a partial pass never increments the counter. In a stack, the counter is per PR. Pause instead of converging when a finding needs user, product, or architecture clarification.

## Ratchet: strengthen the gate

At disposition, tag every confirmed finding with a mechanization candidate: `biome-rule`, `axe-or-playwright`, `test`, `grit-plugin`, or `none`. After convergence, implement ratchets — native mechanisms first (Biome rule/option, Axe/Playwright assertion), then repo tests for behavioral invariants and Grit plugins for syntactic classes; cover the finding's class, not the instance. Ratchet commits ride the same PR. Ask the user before a ratchet that would force broad changes to unrelated code. Every ratcheted class is recall future passes no longer spend.

## Decisions registry

Append discards with durable value (deliberate policy or architecture choices, accepted risks, open product questions) to `.agents/review/decisions.md` per its entry format; it is committed and reviewed like code. Session-specific discards stay in the PR review body.

## Final report

Report from PR state: passes completed (full vs partial) and agent invocations including retries; findings fixed, discarded (with reasons), and needing clarification; threads still open and why; ratchets implemented and candidates left pending; verification gaps; for a stack, its structure and per-PR status. State convergence honestly — "two consecutive clean full fan-outs over N lenses", not "clean" — and hand off what remains to the human: review the PR(s) and arm the merge.
