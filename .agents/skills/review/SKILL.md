---
name: review
description: Strict local workspace review skill. Use by default for any review request. Checks severe defects, AGENTS.md violations, architecture, naming, style drift, tests, documentation accuracy, and nits.
---

# Strict workspace review

Use this skill for local review requests across code, documentation, configuration, workflows, and other workspace changes. Review only; do not edit files unless the user explicitly asks for fixes after the review.

## Review posture

- Act as a strict reviewer looking for problems, regressions, and repo-contract violations.
- Findings must be grounded in inspected files, diffs, tests, command output, `AGENTS.md`, matching skills, or documented framework/package behavior.
- If evidence is incomplete, keep digging until the failure mode is demonstrated or the missing observation is provably out of reach (see evidence below).

## Review scope

- Unless the invoker narrows it, the diff under review is the full working-tree change against the base ref (default `HEAD`): staged and unstaged changes together, plus untracked files. Use `git diff <base>`, `git status --porcelain`, and reads of untracked files.

## Concern lenses (optional)

A lens is a concern-scoped reviewer charter defined by the invoker per review — for example `data integrity & atomicity: transactions, TOCTOU windows, partial-failure consistency, audit ordering`. Lenses are invented to fit the diff, not taken from a fixed list. When invoked with a lens:

- Review the WHOLE diff, but report only findings within the lens. Never narrow the files you look at — cross-file findings (e.g. auth enforced in a layout but missing in the nested loaders it should protect) only appear when the whole relationship is in view.
- Enumerate the lens's surfaces; do not sample them. A security lens states, for every route, data loader, server action, and token/credential path in scope, whether protection holds, at which layer, and whether that layer survives the framework's navigation and caching model. Other lenses enumerate analogously: every mutation for atomicity, every interactive state for accessibility.
- A `catch-all` lens reports anything not owned by another lens running in the same pass, so nothing falls through the seams between lenses.

If no lens is given, review across all concerns as usual.

## Decisions registry

If `.agents/review/decisions.md` exists, read it before reviewing. Its entries are deliberate, already-litigated decisions:

- Do not re-report an accepted decision while its recorded premise still holds.
- Challenge an entry only when its premise no longer holds or with evidence that did not exist when it was decided, as an explicit finding that names the decision id.

## Checks

- Prefer `bun run check` from the repo root for code-affecting changes. If unavailable, inspect `package.json` and run the closest relevant lint/typecheck/test command. For documentation-only changes, use a narrower verification when the full check would not add useful signal.
- If an orchestrator has already run the full deterministic gate for this pass, do not re-run it; rely on its result and run only focused checks relevant to your concern. This avoids re-running the whole gate once per lens in a fan-out.

## Finding categories

Group findings by these sections, ordered by severity within each section:

1. **Blocking Findings** — any `AGENTS.md` violation, even small ones, plus anything that makes the change wrong or unsafe to build on: correctness, security, data loss, accessibility, broken builds or public APIs, invalid types, inaccurate documentation, missing required tests or configuration documentation, architecture and ownership violations.
2. **Non-Blocking Findings** — real issues that should be fixed but do not block acceptance.
3. **Nits** — tiny polish and consistency improvements, kept after substantive findings.

## Evidence

Evidence is demonstration, not belief: what you executed or observed — the failing test, the probe and its output, the traced call path with a concrete bad input. Run focused probes freely (a test file, a scratch script in `/tmp`, a REPL), but never mutate the checkout you share with other reviewers; a probe that needs instrumentation runs in a disposable git worktree you create and remove yourself.

A finding may carry one `unverified` observation only when it lives outside the checkout: an external system's real behavior, production-only state, or a human intent question. Name the exact missing observation.

## Output contract

- When the invoker supplies a structured findings schema, return findings only through that schema — no prose report.
- If no problems are found, say that no review findings were found and summarize what was inspected.
