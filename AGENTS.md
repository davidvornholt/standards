# AGENTS.md

## Quality gates

Do not weaken quality gates to make a change pass. Explain inline suppressions. Use configuration exceptions only where a rule cannot apply, scoped to the affected path and rule.

## Change policy

- Do not build backwards compatibility by default. Migrate every call site and delete the old shape in the same change. Do not add deprecated aliases, versioned copies, or compatibility-only optional parameters.
- Ask before choosing product intent or another costly, durable direction. Assume no background knowledge or familiarity with the code; explain what is at stake, where each option leads, and recommend one before presenting technical evidence.

## Package management

- Use Bun only, at the exact version declared by the root `packageManager`.
- Workspaces using Bun runtime or `bun:test` types must declare `@types/bun`.

## Architecture

- App code lives in `apps/*`. Business logic belongs in `src/features/<domain>` and app-wide infrastructure in `src/shared`. Keep single-app code in the app unless it has an intentional shared contract.
- Shared code lives in `packages/*` and defaults to `src/<capability>.ts(x)` plus colocated tests, with deeper folders only when the capability needs them.
- Package names use the project alias `@<actual-project-name>/<package-name>`. Canonical packages use `@davidvornholt` and change in the standards repository.
- Entrypoints route, parse initial inputs, wire Effect layers, and bridge to runtime or UI.
- Dependency flow is `entrypoint -> features -> shared -> packages`. Features do not import sibling features, and cross-package imports use package aliases rather than relative paths.
- A cohesive boundary file may exceed the 400-line lint limit through a scoped `biome.jsonc` override and an entry in `docs/quality/no-excessive-lines-per-file-exceptions.md`.

## Workspace scripts

- Operational scripts belong to the owning workspace's `package.json`. Keep root scripts minimal: the quality gates plus narrowly useful filtered Turbo convenience aliases.
- Canonical repo-spanning workflows and convenience recipes live in the root `justfile`; project-specific recipes live in `local.just`.

## Effect standards

- Use Effect extensively where it makes code more robust. Keep simple synchronous logic and UI components plain, integrating Effect at boundaries.
- Service contracts expose typed errors and requirements. Represent expected failures with `Data.TaggedError`, a stable `_tag`, and an actionable `message` instead of throwing.
- Workspace-wide exceptions require an architectural reason in `AGENTS.local.md`; keep each workspace consistent.

## Writing style

- Write plainly and directly. Avoid mannered prose, decorative metaphors, and stock phrases. Prefer literal wording and sentences that are easy to follow.
- Use sentence case for reader-facing text — UI copy, labels, command-style actions, Markdown headings — preserving proper nouns, acronyms, filenames, package names, and domain terms.
- Do not hard-wrap Markdown prose; keep each paragraph or list item on one logical line.

## Documentation

Write documentation when it helps someone use, operate, or change the project. Keep it concise and current; do not narrate the implementation or repeat what the code makes clear. Put local rationale near the code and change history in PRs.

## Project-specific rules

This is a canonical file from the standards repository. Project-specific rules belong in `AGENTS.local.md`.

@AGENTS.local.md
