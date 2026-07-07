---
name: review-loop
description: Use when the user asks for a review loop, review pass with fixes, or to keep fixing until review is clean. The review loop may be requested after implementation work or for an existing diff.
---

# Review loop

Use this workflow when the user asks for repeated review/fix passes until reviewer feedback is clean or a finding needs clarification. This skill orchestrates the `review` skill; each review pass runs one or more `reviewer` subagents.

## Mandatory subagents

- A review-loop pass is invalid unless at least one `reviewer` subagent is invoked. If subagent tooling is unavailable, stop and report that blocker; do not substitute a local-only review.
- Valid findings must be fixed by the integrated `worker` subagent. The parent agent orchestrates, validates, updates the ledger, and runs checks; it does not implement fixes directly.

## Principles

- **Gate before reviewing.** Run the repo's full deterministic check command (lint, types, formatting, automated a11y, tests) and fix what it reports BEFORE any `review` pass. Mechanically detectable issues belong here: a deterministic tool finds every instance at once, whereas an LLM reviewer finds a stochastic subset per pass and burns loops re-finding the rest. Start the loop only once the gate passes, so reviewers spend their budget on judgment findings the gate cannot catch.
- **Shard by concern, never by file.** When fanning out, choose reviewers by concern lens (see the `review` skill's concern scope), not by file or directory. File-based sharding hides cross-file findings because no single reviewer sees both sides of the relationship. Every fan-out must include the `catch-all` lens unless an unscoped full reviewer is also run.
- **Separate fan-out scope from review context.** Decide whether to fan out from the delta since the previous review pass. Fan out when that delta is large and spans multiple concerns; a small self-contained local delta usually gets one reviewer. Decide what each reviewer sees separately: concern-scoped lenses, and any reviewer of an architecture-relevant delta, receive the full current diff as context because cross-file findings need both sides in view. Self-contained local deltas (for example, a contrast token or single-file fix) may be reviewed against that delta alone to keep convergence passes cheap and avoid full-surface attention drift.

## Workflow

1. Ensure the requested implementation or existing diff is ready for review.
2. Run the deterministic gate and fix what it reports.
3. Open a durable findings ledger at `.agents/tmp/review-loop-<short-slug>.md` (a gitignored scratch file, not just working memory). Record each ledger operation with the current date and time, including timezone.
4. Identify the delta since the previous review pass, then decide single vs. fan-out using the test above. For the first pass, that delta is the full implementation or existing diff under review. For a fan-out, invoke one `reviewer` subagent per applicable lens (include only lenses the delta touches, plus `catch-all` unless an unscoped full reviewer also runs).
5. Choose reviewer context separately from fan-out: give reviewers running concern-scoped lenses, and reviewers of architecture-relevant deltas, the full current diff; give self-contained local deltas only the delta when broader context is unlikely to change the finding.
6. Run the `reviewer` subagent(s) with the selected context only. Keep each subagent prompt thin:
   - Role: read-only review subagent.
   - Scope: current diff, specific delta, or named files under review.
   - Concern lens: unscoped or the selected lens.
   - Deterministic gate status: passed, failed with provided output, or not run.
   - Output: use the `review` skill output contract.
7. Synthesize into the ledger:
   - Merge all subagent finding lists.
   - Deduplicate overlaps at lens seams (one issue may surface under two lenses).
   - Order by severity: Blocking, then Non-Blocking, then Nits.
8. Validate each finding against local evidence, repo instructions, and user-approved scope.
   - Fix only findings that are real, applicable, and within scope.
   - Do not blindly implement speculative, incorrect, duplicate, or out-of-scope findings.
   - Record discards in the ledger with the reason.
9. Send all valid applicable findings to the integrated `worker` subagent for fixes, preserving the user-approved scope, then run full validation.
10. Repeat from step 4. Stop or pause when the reviewer reports no findings or a finding requires user/product/architecture clarification.
11. In the final response, report from the ledger:
    - The number of review passes completed (a fan-out pass counts as one).
    - The number of reviewer invocations and retries, including invalid/no-result attempts.
    - Which findings were fixed, grouped by pass when useful.
    - Which findings were discarded, with the reason each was invalid, duplicate, out of scope, or needing clarification.
    - Any verification gaps (checks not run, behavior not exercised against a live system).

## Ledger schema

Keep the ledger concise and append-only except for disposition updates. Record at least:

- Scope: user request, base ref or starting diff, and validation gate command.
- Operations: current date and time with timezone for every ledger entry or update, using a stable, unambiguous format such as `YYYY-MM-DD HH:mm:ss Z`.
- Passes: pass number, operation timestamp, delta reviewed, reviewer lens or unscoped reviewer, invocation status, retry count, and checks run.
- Findings: stable ID, operation timestamp, severity, lens, file/line evidence, summary, disposition (`fixed`, `discarded`, or `needs clarification`), disposition reason, and verification after the disposition.
