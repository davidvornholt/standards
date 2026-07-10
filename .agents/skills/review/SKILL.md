---
name: review
description: Strict local workspace review skill. Use by default for any review request, including "review", "code review", "documentation review", workflow/config review, diff review, or pre-merge review in the local workspace. Checks severe defects, AGENTS.md violations, architecture, naming, style drift, tests, documentation accuracy, and nits.
---

# Strict workspace review

Use this skill for local review requests across code, documentation, configuration, workflows, and other workspace changes. Review only; do not edit files unless the user explicitly asks for fixes after the review.

## Review posture

- Act as a strict reviewer looking for problems, regressions, and repo-contract violations.
- Findings must be grounded in inspected files, diffs, tests, command output, `AGENTS.md`, matching skills, or documented framework/package behavior.
- If evidence is incomplete, either inspect more local context or report the finding as `needs-verification` (see confidence below).

## Review scope

- Unless the invoker narrows it, the diff under review is the full working-tree change against the base ref (default `HEAD`): staged and unstaged changes together, plus untracked files. Use `git diff <base>`, `git status --porcelain`, and reads of untracked files.
- An index (staged/unstaged) boundary may exist for change attribution during a review loop; it never narrows review scope.
- When a split-gated review loop (see the `review-loop` skill) scopes the pass to a coupling cluster, "the whole diff" means that cluster's whole delta; the loop's seam check owns the cross-cluster surface.

## Concern lenses (optional)

A lens is a concern-scoped reviewer charter defined by the invoker per review — for example `data integrity & atomicity: transactions, TOCTOU windows, partial-failure consistency, audit ordering`. Lenses are invented to fit the diff, not taken from a fixed list. When invoked with a lens:

- Review the WHOLE diff, but report only findings within the lens. Never narrow the files you look at — cross-file findings (e.g. auth enforced in a layout but missing in the nested loaders it should protect) only appear when the whole relationship is in view.
- Enumerate the lens's surfaces; do not sample them. A security lens states, for every route, data loader, server action, and token/credential path in scope, whether protection holds, at which layer, and whether that layer survives the framework's navigation and caching model. Other lenses enumerate analogously: every mutation for atomicity, every interactive state for accessibility.
- A `catch-all` lens reports anything not owned by another lens running in the same pass, so nothing falls through the seams between lenses.

If no lens is given, review across all concerns as usual.

## Decisions registry

If `.agents/review/decisions.md` exists, read it before reviewing. Its entries are deliberate, already-litigated decisions:

- Do not re-report an accepted decision as a finding.
- Challenge an entry only with evidence that did not exist when it was decided, as an explicit finding that names the decision id.

## What to inspect

Before reviewing, gather enough local context to support findings:

- Read the relevant `AGENTS.md` instructions.
- Inspect the `description` frontmatter for local skills under `.agents/skills/*/SKILL.md` and follow any that match the reviewed changes.
- Inspect the changed files or requested files, plus nearby callers, tests, package manifests, scripts, docs, workflows, and config as needed.
- Prefer `bun run check` from the repo root for code-affecting changes. If unavailable, inspect `package.json` and run the closest relevant lint/typecheck/test command. For documentation-only changes, use a narrower verification when the full check would not add useful signal.
- If an orchestrator has already run the full deterministic gate for this pass, do not re-run it; rely on its result and run only focused checks relevant to your concern. This avoids re-running the whole gate once per lens in a fan-out.

## Finding categories

Group findings by these sections, ordered by severity within each section:

1. **Blocking Findings**
   - Any `AGENTS.md` violation, even small ones.
   - Correctness bugs, runtime crashes, broken builds, security issues, data loss, accessibility failures, invalid types, broken public APIs, inaccurate documentation, missing required env documentation, missing required tests, or architecture boundary violations.
   - Major maintainability issues that should block acceptance, such as misplaced ownership, dependency direction violations, or bad abstractions that make the change unsafe to build on.

2. **Non-Blocking Findings**
   - Real issues that should be fixed but do not block acceptance.
   - Examples: confusing names, unclear errors, weak but present tests, avoidable duplication, awkward structure, minor performance concerns, local style drift, stale documentation, or maintainability risks.

3. **Nits**
   - Tiny polish issues and small consistency improvements.
   - Include nits when they exist, but keep them after substantive findings.

## Confidence

Label every finding:

- `confirmed`: you inspected the defect in context and verified the failure mode is real.
- `needs-verification`: grounded suspicion whose confirmation needs digging you could not complete (dependency internals, runtime behavior, concurrency windows). State exactly what is unverified.

## Output contract

- Use file and line references for every finding whenever possible.
- Explain the impact and the concrete problem, not just a preference.
- Keep findings concise and actionable.
- When the invoker supplies a structured findings schema, return findings only through that schema — no prose report.
- If no problems are found, say that no review findings were found and summarize what was inspected.
- Mention tests or checks run only if they were actually run. Mention meaningful verification gaps when they affect confidence.
