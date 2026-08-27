---
name: review
description: Evidence-based workspace review. Use by default for code, documentation, configuration, and workflow reviews; returns one actionable decision per finding without a second severity taxonomy.
---

# Evidence-based workspace review

Review the requested workspace change without editing it. Be strict about demonstrated defects and strict against speculative scope growth: the goal is to decide whether this change is safe to merge, not to manufacture an endless backlog.

## Review posture

- Ground every finding in inspected files, diffs, tests, command output, repository contracts, matching skills, or documented framework behavior.
- Demonstrate a reachable failure scenario. A theoretical possibility without a concrete path through the changed system is not a finding.
- Judge materiality against the supplied intent and threat model. When they are absent, infer the narrowest reasonable intent from the request, PR description, and changed code, and state that inference in coverage.
- Prefer the smallest correction that restores the intended invariant. Do not recommend a dependency, subsystem, abstraction, fixture framework, parser, guard layer, or broad ratchet when a local change, deletion, narrower claim, or existing mechanism resolves the defect.
- Repository-rule violations are evidence, not an automatic decision. A failing required gate or a broken non-negotiable contract is normally a block; minor style or documentation drift is not merge-blocking unless its concrete consequence is material.

## Review scope

Unless the invoker narrows it, review the full working-tree change against the base ref: staged and unstaged changes plus untracked files. Inspect the whole relationship even when a concern points to one file; cross-file ownership, authorization, persistence, and lifecycle defects are often the actual failure.

## Concern checklist

The invoker may supply several concern charters. One reviewer covers all of them in one pass over the full diff.

- Enumerate the surfaces owned by each concern instead of sampling them. A security concern accounts for every changed route, loader, action, credential path, and protection layer; data integrity accounts for every changed read, mutation, transaction, retry, and migration; other concerns enumerate analogously.
- Include premise and catch-all concerns when supplied. Premise tests whether the change solves the right problem; catch-all reports material defects not owned by another concern.
- Attribute each finding to every concern that actually exposed it. Concern attribution is analysis metadata, not a reason to spawn another reviewer.

## Decisions registry

If `.agents/review/decisions.md` exists, read it before reviewing. Its entries are deliberate decisions recorded by whichever agent or maintainer settled them.

- Do not re-report an accepted decision while its premise still holds.
- Challenge an entry only when its premise changed or new evidence invalidates it, and name the decision id.

## Checks

- Prefer the repository's established gate for an ordinary standalone review. When an orchestrator already supplied an exact-head gate result, do not repeat the full gate; run only focused probes needed to demonstrate a concern.
- A probe that needs instrumentation runs in a disposable worktree. Never mutate the shared checkout.
- Reuse production paths and real inputs where practical. A mock that bypasses the invariant under review is not evidence that the invariant holds.

## One decision per finding

Each reported finding has exactly one `decision`. Do not add a separate blocking/non-blocking/nit severity.

- **block**: demonstrated, inside the change's intent, material under the threat model, and serious enough that a maintainer should stop this merge.
- **defer**: real and actionable, but outside the intent or below the merge-blocking bar. It belongs in separate work and must not expand this PR.
- **discard**: refuted, speculative, already accepted by a still-valid registry decision, or too low-value to schedule. Emit discarded candidates only when recording the reasoning prevents the same concern from recurring; do not report every thought the review considered.
- **ask**: a maintainer must choose between materially different product or architecture outcomes and the repository does not determine the answer. Use `ask` only when choosing wrongly would be costly to reverse because it changes a durable contract, data model, ownership boundary, lifecycle, externally visible behavior, or broad system architecture.

Do not ask about implementation details inferable from the repository, local refactors, test shape within existing infrastructure, reversible naming or copy choices, or a new mechanism that can simply be deferred. For an unresolved but reversible choice, select the simplest in-scope behavior, record the assumption, and continue.

Record these orthogonal fields without turning them into another decision system:

- **impact**: `breakage`, `weakening`, or `polish`.
- **evidenceStatus**: `reproduced`, `demonstrated`, or `unverified`.
- **concerns**: the concern keys that exposed the finding.

An `unverified` finding is allowed only for an observation outside the checkout, such as production state or an external service. It normally becomes `defer`; it becomes `ask` only when the strict decision bar above is met.

## Test recommendations

Recommend at most one minimal regression test per failure class, preferably by extending an existing test. A table-driven test may carry several representative inputs inside that one class.

Do not request tests that pin trivial copy, static literals, type-impossible states, or examples already subsumed by a stronger behavioral test. Browser tests are for browser-, hydration-, focus-, download-, layout-, or accessibility-specific behavior; mappings, parsers, filenames, and payload construction belong in faster tests. Never propose a new fixture or test mechanism for one finding.

## Evidence

Evidence is what was executed or observed: a failing test, a focused probe and its output, or a traced call path with a concrete bad input. Explain the practical failure, not only the suspicious code pattern. If reproduction is impossible because the observation is external, name exactly what remains unknown.

## Output contract

When the invoker supplies a structured schema, return only schema-conformant findings and coverage. Otherwise group the result by `block`, `ask`, `defer`, and durable `discard` decisions, in that order. If nothing qualifies, say that no review findings were found and summarize the inspected surfaces and focused checks.
