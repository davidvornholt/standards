---
name: review
description: Strict local workspace review skill. Use by default for any review request, including "review", "code review", "documentation review", workflow/config review, diff review, or pre-merge review in the local workspace. Checks severe defects, AGENTS.md violations, architecture, naming, style drift, tests, documentation accuracy, and nits.
---

# Strict workspace review

Use this skill for local review requests across code, documentation, configuration, workflows, and other workspace changes. Review only; do not edit files unless the user explicitly asks for fixes after the review.

## Review posture

- Act as a strict reviewer looking for problems, regressions, and repo-contract violations.
- Findings must be grounded in inspected files, diffs, tests, command output, `AGENTS.md`, matching skills, or documented framework/package behavior.
- Do not hallucinate requirements, business rules, files, APIs, runtime behavior, tests, command results, or user intent.
- If evidence is incomplete, either inspect more local context or describe the risk precisely without pretending it is confirmed.

## Concern scope (optional)

If invoked with a concern lens (e.g. "security", "accessibility", "types", "architecture", "tests", "docs", or "catch-all"):

- Review the WHOLE diff, but report only findings within that concern. Never narrow the files you look at — cross-file findings (e.g. auth enforced in a layout but missing in the nested loaders it should protect) only appear when the whole relationship is in view.
- The posture, finding categories, and output contract below all apply within the lens.
- For the `security` lens: enumerate security surfaces; do not sample them. For every route, data loader, server action, and token/credential path in scope, state whether auth is enforced, at which layer, and whether that layer survives the framework's navigation and caching model (e.g. framework layouts that do not re-run on client-side navigation). List each surface explicitly rather than reporting only the ones that stand out.
- The catch-all lens reports anything not owned by another named lens, so nothing falls through the seams between lenses.

If no concern lens is given, review across all concerns as usual.

## What to inspect

Before reviewing, gather enough local context to support findings:

- Read the relevant `AGENTS.md` instructions.
- Inspect the `description` frontmatter for local skills under `.agents/skills/*/SKILL.md` and follow any that match the reviewed changes.
- Inspect the changed files or requested files, plus nearby callers, tests, package manifests, scripts, docs, workflows, and config as needed.
- Use `git diff`, `git status`, `rg`, and focused file reads to understand scope.
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

## Output contract

- Use file and line references for every finding whenever possible.
- Explain the impact and the concrete problem, not just a preference.
- Keep findings concise and actionable.
- If no problems are found, say that no review findings were found, summarize what was inspected, and mention checks actually run.
- If findings exist, end by asking whether you should fix all findings and issues.
- Mention tests or checks run only if they were actually run. Mention meaningful verification gaps when they affect confidence.
