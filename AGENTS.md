# AGENTS.md

This file is the root operating contract for agents in this repository. Keep root instructions for non-negotiable constraints; put specialized workflows in `.agents/skills/*/SKILL.md`.

## Quality gates

- Never weaken a quality gate (lint, types, tests, a11y) to make a change pass. Fix findings in the code instead of downgrading or disabling rules.
- Every inline suppression needs a reason. Use a per-file override only when a rule genuinely cannot apply, narrowed to that path and rule.

## Change policy

- Do not build backwards compatibility by default. Migrate every call site and delete the old shape in the same change. Do not add deprecated aliases, versioned copies, or compatibility-only optional parameters.
- Ask before choosing product intent or another costly, durable direction. Assume no background knowledge or familiarity with the code; explain what is at stake, where each option leads, and recommend one before presenting technical evidence.
- Propose before changing CI workflows, quality gates, or canonical synced files, even to unblock a failure. The file class is the trigger.

## Package management

- Use Bun only, at the exact version declared by the root `packageManager`.
- Add dependencies with `bun add`; do not manually edit dependency versions into `package.json`.
- Workspaces that rely on Bun runtime or `bun:test` types must declare `@types/bun`, not custom ambient declaration shims.

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

- Decode untrusted input with Schema before using it.
- Required for async work, concurrency, retries, timeouts, resource acquisition, cancellation, and injected dependencies; at service boundaries the error and requirement channels are the contract.
- Not required for total synchronous logic or UI components, which stay plain and consume Effect at the boundary.
- Never `throw` for expected failures; return typed Effect errors. Recoverable errors are `Data.TaggedError` classes with stable `_tag` values and actionable `message` fields.
- A workspace may opt out wholesale only for a stated architectural reason recorded in `AGENTS.local.md`; do not mix idioms inside one workspace.

## Writing style

- Use sentence case for reader-facing text — UI copy, labels, command-style actions, Markdown headings — preserving proper nouns, acronyms, filenames, package names, and domain terms.
- Comment only non-obvious intent.
- Do not hard-wrap Markdown prose; keep each paragraph or list item on one logical line.

## Definition of done

1. Test changed behavior and regression-prone states. Do not add tests that only pin trivial copy, static literals, or type-impossible states.
2. Search for stale references to changed concepts, names, paths, configuration, secrets, commands, public APIs, error types, or architectural patterns. Update docs and SOPS secret examples when needed.
3. Run `bun run check:fix` from the repo root for code changes. If it fails, read the full error, fix the root cause, and run it again.

For documentation-only changes, run a narrower verification when the full check would not add useful signal.

## Project-specific rules

This file is canonical and synced from the standards template — do not edit it locally. Project-specific rules that extend this contract live in `AGENTS.local.md`; add local guidance there instead.

@AGENTS.local.md
