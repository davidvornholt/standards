---
name: review
description: Use when asked for a read-only review of code, documentation, configuration, or workflows. Returns evidence-backed decisions without editing.
---

# Review

Review the requested change without editing it. The goal is a trustworthy merge decision, not the longest list of findings.

## Evidence

Read the full diff against the supplied base, including how the changed files depend on each other. A finding needs a reachable failure scenario, grounded in something you inspected or ran. Judge materiality against the supplied intent and threat model. A departure from a repository rule is evidence, not automatically a blocker.

Probe as much as you need, but don't modify the shared checkout. Put instrumented probes in a disposable worktree. If you were given a gate result for the exact head, don't rerun the full gate, and use focused probes instead.

## Lenses

When you're given a lens, report only its failure class and respect its exclusions. Within your lens, go through every surface it owns rather than sampling. Read files outside the lens when they prove an in-lens finding.

## Decisions

Give each finding exactly one decision:

- `block`: demonstrated, within the intent, material under the threat model, and serious enough to stop this merge.
- `defer`: real and actionable, but outside this pull request or below the merge bar.
- `discard`: refuted, speculative, already accepted, or not worth scheduling.
- `ask`: the repository can't choose between materially different, durable product or architecture outcomes, and choosing wrong would be expensive to reverse.

Reserve `ask` for that case, and decide inferable or reversible choices yourself. Recommend the smallest correction within scope, and defer optional machinery.

Also record each finding's `impact`: `breakage`, `weakening`, or `polish`. This is the consequence if the change ships as it is, not the size of the fix.

Documentation, comments, or instructions that break the documentation rule, whether the diff adds them or leaves them stale, are `block` findings with impact `polish`. Quote the passages to cut.

## Test recommendations

Recommend at most one minimal regression test per failure class, preferably by extending an existing test. Propose browser tests only for browser-specific behavior, and never a new fixture or test mechanism for a single finding.

## Output

Group findings by `block`, `ask`, `defer`, and the `discard` decisions worth keeping on record. If nothing qualifies, say so and summarize the surfaces you inspected and the focused checks you ran.
