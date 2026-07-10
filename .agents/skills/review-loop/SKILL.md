---
name: review-loop
description: Use when the user asks for a review loop, review pass with fixes, or to keep fixing until review is clean. The review loop may be requested after implementation work or for an existing diff. Broad diffs covering multiple unrelated aspects go through the split gate first and are reviewed and committed per coupling cluster.
---

# Review loop

Use this workflow when the user asks for repeated review/fix passes until reviewer feedback is clean or a finding needs clarification. This skill orchestrates the `review` skill; each review pass runs one or more `reviewer` subagents.

## Mandatory subagents

- A review-loop pass is invalid unless at least one `reviewer` subagent is invoked. If subagent tooling is unavailable, stop and report that blocker; do not substitute a local-only review.
- Valid findings must be fixed by the integrated `worker` subagent. The parent agent orchestrates, validates, updates the ledger, and runs checks; it does not implement fixes directly.

## Principles

- **Gate before reviewing.** Run the repo's full deterministic check command (lint, types, formatting, automated a11y, tests) and fix what it reports BEFORE any `review` pass. Mechanically detectable issues belong here: a deterministic tool finds every instance at once, whereas an LLM reviewer finds a stochastic subset per pass and burns loops re-finding the rest. Start the loop only once the gate passes, so reviewers spend their budget on judgment findings the gate cannot catch.
- **Shard by concern, never by file.** When fanning out, choose reviewers by concern lens (see the `review` skill's concern scope), not by file or directory. File-based sharding hides cross-file findings because no single reviewer sees both sides of the relationship. Every fan-out must include the `catch-all` lens unless an unscoped full reviewer is also run.
- **Split broad multi-aspect diffs before reviewing.** When the diff contains several unrelated changes, one review pass over all of them dilutes reviewer attention across content no single finding can span. Run the split gate (below): partition the diff into coupling clusters, then review and commit each cluster in isolation. Sharding by cluster is not sharding by file — the coupling map is the evidence that no cross-cluster finding exists, the per-cluster gate tests that evidence mechanically, and the seam check covers what remains.
- **Separate fan-out scope from review context.** Decide whether to fan out from the delta since the previous review pass. Fan out when that delta is large and spans multiple concerns; a small self-contained local delta usually gets one reviewer. Decide what each reviewer sees separately: concern-scoped lenses, and any reviewer of an architecture-relevant delta, receive the full current diff as context because cross-file findings need both sides in view. Self-contained local deltas (for example, a contrast token or single-file fix) may be reviewed against that delta alone to keep convergence passes cheap and avoid full-surface attention drift.

## Split gate (broad multi-aspect diffs)

Vocabulary:

- **Theme**: a set of changes serving one intent — what would be one commit subject line.
- **Coupling**: an observable relationship between two themes that means a reviewer seeing only one of them could miss or misjudge a finding. Edges in decreasing strength: an interleaved file (one file carries hunks of both themes), a code dependency (one theme consumes an API the other introduces or changes), a shared artifact (both edit the same config, manifest, or lockfile), and semantic coupling (shared runtime behavior with no shared text).
- **Cluster**: a connected component of the theme graph under coupling edges. The cluster is the smallest unit reviewable in isolation without losing cross-file findings. Never shard below it; refusing to split above it wastes reviewer attention.

Procedure, after the deterministic gate and before the first review pass:

1. Map themes, coupling edges, and clusters (delegate the mapping to a subagent) and record the map in the ledger.
2. Check separability mechanically: split only when no file carries hunks from two different clusters. A single cluster, non-separable clusters, or a trivially small diff skips the split gate — run the normal loop on the whole diff.
3. Propose the split as an ordered commit plan with draft messages and wait for explicit user approval. Never restructure the working tree without it.
4. Snapshot the full working tree to a recoverable ref before touching anything.
5. Per cluster, in dependency order:
   - Stage the cluster's files, then park everything else with `git stash push --keep-index --include-untracked`.
   - Run the deterministic gate on the isolated cluster. A failure that the whole diff did not have is evidence of hidden coupling: restore the snapshot, merge the affected clusters, and re-plan. Do not patch around it.
   - Run the review loop (steps 5–11 below) on the cluster delta. Fixes must stay within the cluster's file set; defer anything a reviewer wants to change outside it to the seam check.
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

## Workflow

1. Ensure the requested implementation or existing diff is ready for review.
2. Run the deterministic gate and fix what it reports.
3. Open a durable findings ledger at `.agents/tmp/review-loop-<short-slug>.md` (a gitignored scratch file, not just working memory). Record each ledger operation with the current date and time, including timezone.
4. Apply the split gate when the diff spans multiple unrelated aspects. If it splits the diff, run steps 5–11 as the inner loop per cluster delta, then finish with the seam check before the final report; otherwise continue on the whole diff.
5. Identify the delta since the previous review pass, then decide single vs. fan-out using the test above. For the first pass, that delta is the full implementation or existing diff under review — or the current cluster delta inside a split. For a fan-out, invoke one `reviewer` subagent per applicable lens (include only lenses the delta touches, plus `catch-all` unless an unscoped full reviewer also runs).
6. Choose reviewer context separately from fan-out: give reviewers running concern-scoped lenses, and reviewers of architecture-relevant deltas, the full current diff (the cluster delta inside a split); give self-contained local deltas only the delta when broader context is unlikely to change the finding.
7. Run the `reviewer` subagent(s) with the selected context only. Keep each subagent prompt thin:
   - Role: read-only review subagent.
   - Scope: current diff, specific delta, or named files under review.
   - Concern lens: unscoped or the selected lens.
   - Deterministic gate status: passed, failed with provided output, or not run.
   - Output: use the `review` skill output contract.
8. Synthesize into the ledger:
   - Merge all subagent finding lists.
   - Deduplicate overlaps at lens seams (one issue may surface under two lenses).
   - Order by severity: Blocking, then Non-Blocking, then Nits.
9. Validate each finding against local evidence, repo instructions, and user-approved scope.
   - Fix only findings that are real, applicable, and within scope.
   - Do not blindly implement speculative, incorrect, duplicate, or out-of-scope findings.
   - Record discards in the ledger with the reason.
10. Send all valid applicable findings to the integrated `worker` subagent for fixes, preserving the user-approved scope, then run full validation.
11. Repeat from step 5. Stop or pause when the reviewer reports no findings or a finding requires user/product/architecture clarification.
12. In the final response, report from the ledger:
    - Whether the split gate ran: the clusters, the commits created, and the seam-check decision with its evidence.
    - The number of review passes completed (a fan-out pass counts as one).
    - The number of reviewer invocations and retries, including invalid/no-result attempts.
    - Which findings were fixed, grouped by pass when useful.
    - Which findings were discarded, with the reason each was invalid, duplicate, out of scope, or needing clarification.
    - Any verification gaps (checks not run, behavior not exercised against a live system).

## Ledger schema

Keep the ledger concise and append-only except for disposition updates. Record at least:

- Scope: user request, base ref or starting diff, and validation gate command.
- Split gate, when it ran: the theme map with coupling edges, cluster assignment per changed file, separability evidence, user approval, snapshot ref, per-cluster commit hashes, and the seam-check decision with its evidence.
- Operations: current date and time with timezone for every ledger entry or update, using a stable, unambiguous format such as `YYYY-MM-DD HH:mm:ss Z`.
- Passes: pass number, operation timestamp, delta reviewed, reviewer lens or unscoped reviewer, invocation status, retry count, and checks run.
- Findings: stable ID, operation timestamp, severity, lens, cluster (when the split gate ran), file/line evidence, summary, disposition (`fixed`, `discarded`, or `needs clarification`), disposition reason, and verification after the disposition.
