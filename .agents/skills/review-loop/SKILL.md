---
name: review-loop
description: Use when the user asks for a review loop, review pass with fixes, or to keep fixing until review is clean. The review loop may be requested after implementation work or for an existing diff. Broad diffs covering multiple unrelated aspects go through the split gate first and are reviewed and committed per coupling cluster.
---

# Review loop

Repeated review/fix passes over the current diff until convergence is evidenced, not just asserted — see the stopping rule. Along the way, convert every confirmed finding class into deterministic gate coverage where possible.

This skill orchestrates the `review` skill.

## Roles

- **Orchestrator** (the invoking agent): owns the ledger, the split gate, lens selection, dispositions, convergence accounting, gate runs, registry updates, and the final report. Does not implement fixes directly.
- **`reviewer` subagents**: read-only finding and verification passes under the `review` skill contract.
- **Worker subagent**: applies dispositioned fixes. Must never run `git add`, `git commit`, or `git stash`.

If subagent tooling is unavailable, stop and report that blocker; do not substitute a local-only review.

## Setup

1. Stage the entire pre-loop state with `git add -A`. From here on the index is the attribution boundary: `git diff --staged` is the work under review as the user handed it over; `git diff` plus new untracked files is what the loop changed (including gate `lint:fix` output, which is loop work). Only the split gate (below) may re-point the index; nothing else in the loop touches it again.
2. Record a recovery snapshot in the ledger: the commit SHA printed by `git stash create` (it records state without modifying the worktree or index).
3. Open a durable ledger at `.agents/tmp/review-loop-<short-slug>.md`. Timestamp every entry (`YYYY-MM-DD HH:mm:ss Z`).
4. Run the deterministic gate (root `bun run check:fix`) and fix what it reports BEFORE any review pass. Mechanically detectable issues belong to the gate: it finds every instance at once, whereas a reviewer finds a stochastic subset per pass. Review passes start only on a green gate.
5. Read `.agents/review/decisions.md` (if present); pass its content to every reviewer.

## Split gate (broad multi-aspect diffs)

When the diff contains several unrelated changes, one review pass over all of them dilutes reviewer attention across content no single finding can span. Partition the diff into coupling clusters, then review and commit each cluster in isolation. Sharding by cluster is not sharding by file — the coupling map is the evidence that no cross-cluster finding exists, the per-cluster gate tests that evidence mechanically, and the seam check covers what remains.

Vocabulary:

- **Theme**: a set of changes serving one intent — what would be one commit subject line.
- **Coupling**: an observable relationship between two themes that means a reviewer seeing only one of them could miss or misjudge a finding. Edges in decreasing strength: an interleaved file (one file carries hunks of both themes), a code dependency (one theme consumes an API the other introduces or changes), a shared artifact (both edit the same config, manifest, or lockfile), and semantic coupling (shared runtime behavior with no shared text).
- **Cluster**: a connected component of the theme graph under coupling edges. The cluster is the smallest unit reviewable in isolation without losing cross-file findings; never shard below it.

Procedure, after setup and before the first review pass:

1. Map themes, coupling edges, and clusters (delegate the mapping to a subagent) and record the map in the ledger.
2. Check separability mechanically: split only when no file carries hunks from two different clusters. A single cluster, non-separable clusters, or a trivially small diff skips the split gate — run the normal loop on the whole diff.
3. Propose the split as an ordered commit plan with draft messages and wait for explicit user approval. Never restructure the working tree without it.
4. Confirm the setup recovery snapshot covers the full working tree; it is the restore point for the whole split.
5. Per cluster, in dependency order:
   - Re-point the index at the cluster: reset the index to `HEAD`, stage the cluster's files, then park everything else with `git stash push --keep-index --include-untracked`. This re-establishes the setup attribution invariant, now scoped to the cluster.
   - Run the deterministic gate on the isolated cluster. A failure that the whole diff did not have is evidence of hidden coupling: restore the snapshot, merge the affected clusters, and re-plan. Do not patch around it.
   - Run the loop below (lens selection, passes, stopping rule) on the cluster. Fixes must stay within the cluster's file set; defer anything a reviewer wants to change outside it to the seam check.
   - Commit via the `git-commit` skill, `git stash pop`, and continue with the next cluster.
6. Run the seam check, proportional to residual risk:
   - Clusters that are file-disjoint, independently gate-clean, and without a shared runtime: skip the seam check and record that evidence in the ledger.
   - A shared surface exists (shared config, docs describing several clusters, cross-cluster naming): one reviewer reads exactly that surface against all cluster commits.
   - Only a forced or ambiguous split (hunks assigned by judgment rather than file boundaries) earns a full catch-all pass over the combined diff.

### Parallel execution with the Workflow tool

When cluster count and size justify it, execute step 5 of the split gate with the Workflow tool instead of serially:

- Export one patch per cluster from the working tree; pass the approved cluster map and patch paths as workflow `args`.
- Run one agent per cluster with `isolation: 'worktree'`: apply the patch onto clean HEAD, run the gate, run the review/fix loop, and commit on a `split/<cluster>` branch. Worktrees share the object database, so the branches are visible to the main checkout.
- Enforce the disjointness check and the proportional seam-check decision in script code, not agent judgment.
- After the workflow returns, cherry-pick the `split/<cluster>` branches onto the working branch in dependency order from the main checkout.
- The approval in split-gate step 3 stays in conversation; the workflow itself never restructures the user's working tree.
- Each worktree pays its own dependency install; weigh that cost against wall-clock savings before parallelizing small clusters.

## Lens selection

- Invent the lens set per diff: read the diff, decide which concern-scoped reviewers this change deserves, and give each lens a one-line charter (see the `review` skill's lens contract).
- Every fan-out includes a `catch-all` lens unless an unscoped full reviewer also runs.
- Before pass 1, record the lens set and a one-line justification in the ledger. A diff containing database mutations without a data-integrity lens, or auth surfaces without a security lens, is a lens-selection error.

## Pass structure

A pass is one fan-out of reviewers over the FULL current diff (staged + unstaged + untracked, against `HEAD`) — never over just the latest fix delta. Inside a split, the current cluster's whole delta is that diff. Verifying that a fix is correct is a disposition step, not a pass.

When the Claude Workflow tool is available, run each pass as the saved `review-pass` workflow:

```
Workflow({ name: 'review-pass', args: {
  passNumber, baseRef: 'HEAD', gateStatus,
  decisions,                     // registry content, or '(none)'
  lenses: [{ key, charter, notes }]  // notes: what changed since this lens last ran
}})
```

It fans out one `reviewer` subagent per lens with schema-enforced findings, pipelines every blocking or `needs-verification` finding into a read-only refutation agent, dedupes across lens seams, and returns one merged, severity-ordered finding set plus per-lens coverage statements.

Without the Workflow tool (other harnesses or model families), spawn `reviewer` subagents directly with the same thin prompt contract — role, full-diff scope, lens charter, gate status, decisions registry, JSON finding shape with confidence — and apply the same refute-then-merge step. The pass semantics must be identical either way.

Then, per pass:

1. **Disposition** every finding against local evidence, repo contracts, and the registry: to-fix, `discarded` (with reason), or `needs clarification` (pause and ask the user). Do not blindly implement speculative, incorrect, duplicate, or out-of-scope findings. Spawn an additional refutation reviewer only when confirmation genuinely requires digging the pass's verify stage did not settle.
2. **Fix**: send all accepted blocking/non-blocking findings to one worker subagent, batched. Batch nits separately; they may be deferred to a single end-of-loop fix round.
3. **Gate**: re-run the deterministic gate, verify each fix with focused checks, and record dispositions and verification in the ledger.

## Stopping rule

Track a dry counter of consecutive FULL fan-outs (all selected lenses, fresh reviewer contexts) that produced zero new confirmed blocking or non-blocking findings:

- Any new confirmed blocking or non-blocking finding resets the counter to 0.
- Nits, refuted findings, and discards do not reset it. Nit fixes do not reset it.
- Intermediate passes may re-sample only the lenses that produced confirmed findings plus `catch-all` (cheaper, converges faster), but a partial pass never increments the counter.
- The loop converges at counter = 2: two consecutive clean full fan-outs. One clean pass is a sample, not proof — a fresh fan-out after a "clean" pass turning up a new batch of findings is the documented failure mode this rule exists to prevent.
- Inside a split, the counter and convergence are per cluster; a cluster commits only after it converges.
- Pause instead of converging when a finding needs user, product, or architecture clarification.

## Ratchet: strengthen the gate

At disposition time, tag every confirmed finding with a mechanization candidate: `biome-rule`, `axe-or-playwright`, `test`, `grit-plugin`, or `none` (judgment-only). After convergence:

- Implement ratchets with native mechanisms first: Biome-native rule or option, then Axe/Playwright assertion. Below native coverage, choose by the shape of the finding class: behavioral invariants (rollback, ordering, sanitization semantics) become repo tests; syntactic, pattern-shaped classes become Grit plugins, which catch every future instance repo-wide and are reusable across repositories. Prefer the mechanism that covers the whole class, not just the found instance.
- Ask the user first when a ratchet would force broad changes to unrelated code (per `AGENTS.md`).
- Ratchet changes run through the gate like any other change; leave unimplemented candidates in the final report.

Every ratcheted finding class is recall future review passes no longer need to spend.

## Decisions registry maintenance

Append an entry to `.agents/review/decisions.md` when a discard has durable value: a deliberate policy or architecture choice, an accepted risk, or an open product question. Session-specific discards (false positive, reviewer misreading) stay in the ledger only. The registry is committed and reviewed like code; follow its entry format.

## Ledger schema

Keep the ledger concise and append-only except for disposition updates. Record at least:

- Scope: user request, base ref, gate command, staging boundary and recovery SHA, model family.
- Split gate, when it ran: the theme map with coupling edges, cluster assignment per changed file, separability evidence, user approval, snapshot ref, per-cluster commit hashes, and the seam-check decision with its evidence.
- Lens set with justification; updated when it changes.
- Passes: number, timestamp, full or partial fan-out, lenses run, cluster (when the split gate ran), invocation status and retries, gate state before the pass, dry-counter value after disposition.
- Findings: stable ID, timestamp, severity, lens, cluster (when the split gate ran), file/line evidence, summary, confidence and verification outcome, disposition with reason, ratchet tag, and fix verification.

## Final report

Report from the ledger:

- Whether the split gate ran: the clusters, the commits created, and the seam-check decision with its evidence.
- Passes completed (full vs. partial fan-outs) and reviewer/worker invocations, including retries and invalid attempts.
- Findings fixed, discarded (with reasons), and needing clarification, grouped by pass when useful.
- Registry entries added; ratchets implemented and candidates left pending.
- Verification gaps (checks not run, behavior not exercised against a live system).
- The loop-attributed change summary (`git diff --stat`; unstaged changes are the loop's work), or the per-cluster commits when the split gate ran.
- The convergence evidence, stated honestly: "two consecutive clean full fan-outs over N lenses", not "clean".
