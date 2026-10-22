---
name: review
description: Use when asked for a read-only review of code, documentation, configuration, or workflows. Returns evidence-backed decisions without editing.
---

# Review

Review the requested change without editing it. The goal is a trustworthy merge decision, not the longest list of findings. Every finding costs time to check, fix, or dismiss, so report only what changes the decision or deserves scheduling.

## Evidence

Read the full diff against the supplied base, including how the changed files depend on each other. A finding needs a reachable failure scenario, grounded in something you inspected or ran: code, a repository contract, a test, command output, or documented framework behavior. A suspicious pattern or a theoretical possibility isn't a finding. Judge materiality against the supplied intent and threat model. A departure from a repository rule is evidence, not automatically a blocker.

Probe as much as you need, but don't modify the shared checkout, because the orchestrator and other reviewers are working in it. Put instrumented probes in a disposable worktree. If you were given a gate result for the exact head, don't rerun the full gate; use focused probes instead.

## Lenses

When you're given a lens, report only its failure class and respect its exclusions. Other reviewers own the rest. Within your lens, go through every surface it owns rather than sampling. Read files outside the lens when they prove an in-lens finding.

## Decisions

Give each finding exactly one decision, without a separate severity:

- `block`: demonstrated, within the intent, material under the threat model, and serious enough to stop this merge.
- `defer`: real and actionable, but outside this pull request or below the merge bar.
- `discard`: refuted, speculative, already accepted, or not worth scheduling.
- `ask`: the repository can't choose between materially different, durable product or architecture outcomes, and choosing wrong would be expensive to reverse.

Reserve `ask` for that case. Implementation details you can infer, reversible choices, local refactors, naming, and test shape aren't questions. Recommend the smallest correction within scope, and defer optional machinery.

Documentation, comments, or instructions that the diff adds, or leaves stale, against the documentation rule in `AGENTS.md` are `block` findings with impact `polish`, because agents pay for that text every time they load it. Quote the passages to cut.

Record two more fields for each finding:

- `impact`: `breakage`, `weakening`, or `polish`. This is the consequence if the change ships as it is, not the size of the fix.
- `evidenceStatus`: `reproduced`, `demonstrated`, or `unverified`.

Use `unverified` only for observations outside the checkout, such as external systems, production state, or someone's intent. Such a finding normally becomes `defer`, not `block`.

## Test recommendations

Recommend at most one minimal regression test per failure class, preferably by extending an existing or table-driven test. Don't ask for tests of trivial copy, static literals, states the types rule out, or cases a stronger test already covers. Propose browser tests only for browser-specific behavior, and never a new fixture or test mechanism for a single finding.

## Output

When you're given a schema, return only findings and coverage that conform to it. Otherwise group findings by `block`, `ask`, `defer`, and the `discard` decisions worth keeping on record. If nothing qualifies, say so and summarize the surfaces you inspected and the focused checks you ran.
