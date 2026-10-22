# AGENTS.md

## Quality gates

Don't weaken a quality gate to make a change pass. Explain every inline suppression where it appears. Use a configuration exception only where a rule can't apply, scoped to the affected path and rule.

## Change policy

Don't build backwards compatibility by default. Code in these repositories has no consumers outside them, so migrate every call site and delete the old shape in the same change.

Ask before choosing product intent or another costly, durable direction, because those choices are the user's and expensive to reverse. Write the question for someone with no background who hasn't read the code: explain what's at stake and where each option leads, and recommend one before presenting technical evidence.

## Package management

Use Bun only, at the exact version declared by the root `packageManager`. Workspaces that use the Bun runtime or `bun:test` types declare `@types/bun` themselves.

## Architecture

- App code lives in `apps/*`. Business logic belongs in `src/features/<domain>` and app-wide infrastructure in `src/shared`. Code used by one app stays in that app unless it has an intentional shared contract.
- Shared code lives in `packages/*`, by default as `src/<capability>.ts(x)` with colocated tests, and with deeper folders only when the capability needs them.
- Package names use the project alias `@<actual-project-name>/<package-name>`. Canonical packages use `@davidvornholt` and change in the standards repository.
- Entrypoints route, parse initial inputs, wire Effect layers, and bridge to the runtime or UI.
- Dependencies flow `entrypoint -> features -> shared -> packages`. Features don't import sibling features, and cross-package imports use package aliases rather than relative paths.
- A cohesive boundary file may exceed the 400-line lint limit through a scoped `biome.jsonc` override and an entry in `docs/quality/no-excessive-lines-per-file-exceptions.md`.

## Workspace scripts

Operational scripts belong in the owning workspace's `package.json`. Root scripts stay minimal: the quality gates, including `lint` and `lint:fix`, plus a few filtered Turbo aliases that are actually useful. Biome lints the whole repository once from the root, so workspaces don't declare lint scripts. Canonical repo-spanning workflows and convenience recipes live in the root `justfile`, and project-specific recipes in `local.just`.

## Effect standards

Use Effect wherever it makes code more robust, and keep simple synchronous logic and UI components plain, integrating Effect at their boundaries. Service contracts expose typed errors and requirements, so callers see every expected failure in the type. Represent expected failures with `Schema.TaggedError`, a stable `_tag`, and an actionable `message` instead of throwing. In an Effect v4 workspace, the agent guide shipped at `node_modules/effect/AGENTS.md` covers idioms this section doesn't.

A workspace-wide exception to these rules needs an architectural reason in `AGENTS.local.md`. Within one workspace, stay consistent.

## Writing style

Write plainly and directly, in literal wording and complete sentences that are easy to follow. Avoid mannered prose and stock phrases, and don't compress sentences into fragments to save words.

Use sentence case for reader-facing text, including Markdown headings.

Don't hard-wrap Markdown prose. Keep each paragraph or list item on one logical line.

## Documentation and instructions

Agents are the main readers of documentation, skills, and instructions, and every word costs tokens on each read. Write only what the code and its tooling can't carry, such as procedures, external constraints, and the reasons for non-obvious decisions. State each fact once and link to it. Keep history and status in PRs and issues. When a change makes documentation stale or derivable, cut it in the same change. Read only the documentation relevant to the current task.

Write skills and instructions for a capable model:

- Leave out what it does without being told, and spend words on what it can't know.
- Skip examples it can infer. When a rule is unclear without one, one example is usually enough.
- Give the reason for any rule that isn't self-evident, so the model can apply it to cases the text doesn't name.
- Use prose for workflows and reasoning, lists for independent items, tables for lookups, and numbered steps only where order matters.
- State each rule calmly and once. Capitals, bold, and "never" or "always" make capable models over-apply a rule, so save absolutes for hard constraints.

## Project-specific rules

This is a canonical file from the standards repository. Project-specific rules belong in `AGENTS.local.md`.

@AGENTS.local.md
