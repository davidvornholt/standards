---
name: review
description: Use when asked for a read-only review of code, documentation, configuration, or workflows. Returns evidence-backed decisions without editing.
---

# Review

Review the requested change without editing it. The goal is a trustworthy merge decision, not the largest possible backlog.

## Evidence and scope

- Read the full diff against the supplied base, including cross-file relationships. When given a lens, report only its primary failure class and honor its exclusions.
- Ground findings in inspected code, repository contracts, tests, command output, or documented framework behavior.
- Show a reachable failure scenario. Suspicious patterns or theoretical possibilities alone are not findings.
- Judge materiality against the supplied intent and threat model. Repository-rule drift is evidence, not automatically a blocker.
- Read `.agents/review/decisions.md` when present and do not reopen a still-valid decision without new evidence.
- If an exact-head gate result was supplied, do not rerun the full gate. Use focused probes only. Instrumented probes belong in a disposable worktree; never modify the shared checkout.

Enumerate the surfaces owned by the lens rather than sampling them. Read other files when they prove an in-lens finding, but do not duplicate another lens’s charter.

## Decisions

Return exactly one decision per finding; do not add a separate severity:

- **block** — demonstrated, in intent, material under the threat model, and serious enough to stop this merge.
- **defer** — real and actionable, but outside the PR or below the merge bar.
- **discard** — refuted, speculative, already accepted, or too low-value to schedule. Report only durable discards worth recording.
- **ask** — the repository cannot choose between materially different durable product or architecture outcomes, and choosing wrongly would be expensive to reverse.

Do not ask about inferable implementation details, reversible choices, local refactors, naming, or test shape. Prefer the smallest in-scope correction and defer optional machinery.

Also record:

- `impact`: `breakage`, `weakening`, or `polish`;
- `evidenceStatus`: `reproduced`, `demonstrated`, or `unverified`.

Use `unverified` only for an observation outside the checkout. It normally becomes `defer`, not `block`.

## Test recommendations

Recommend at most one minimal regression test per failure class, preferably by extending an existing or table-driven test. Do not request tests for trivial copy, static literals, type-impossible states, or examples already covered by a stronger test. Use browser tests only for browser-specific behavior, and never propose a new fixture or test mechanism for one finding.

## Output

When given a schema, return only schema-conformant findings and coverage. Otherwise group findings by `block`, `ask`, `defer`, and durable `discard`. If none qualify, state that and summarize the inspected surfaces and focused checks.
