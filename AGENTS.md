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

Use Effect extensively wherever it makes sense, because it helps agents write more robust code. In an Effect v4 workspace, follow the agent guide shipped at `node_modules/effect/AGENTS.md`, because v4's API differs from the v3 most models learned.

## Writing style

Write plainly and directly, in literal wording and complete sentences that are easy to follow. Avoid mannered prose and stock phrases, and don't compress sentences into fragments to save words.

Use sentence case for reader-facing text, including Markdown headings.

Don't hard-wrap Markdown prose.

## Documentation and instructions

Agents are the main readers of documentation, skills, and instructions, and every word costs tokens on each read. Write only what a capable model can't learn from the code or infer on its own, give the reason for a rule that isn't obvious, and state each fact once. Keep history and status in PRs and issues, and cut documentation in the same change that makes it stale.

## Project-specific rules

This is a canonical file from the standards repository. Project-specific rules belong in `AGENTS.local.md`.

@AGENTS.local.md
