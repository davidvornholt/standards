# AGENTS.md

## Quality gates

Don't weaken a quality gate to make a change pass. Explain every inline suppression where it appears. Use a configuration exception only where a rule can't apply, scoped to the affected path and rule.

## Change policy

Don't build backwards compatibility by default. Code in these repositories has no consumers outside them, so migrate every call site and delete the old shape in the same change.

Ask before choosing product intent or another costly, durable direction. In the question, explain what's at stake and where each option leads, and recommend one before presenting technical evidence.

Disagree openly when an instruction, plan, or rule seems wrong, and say what you would do instead. Recommend the better option even when it's a bigger change than was asked for.

Before merging a pull request of any size, run `review-fix` if you judge that a reviewer could find a bug in it that someone would otherwise run into. Standards syncs are exempt, because a consumer can't change synced files.

## Writing style

Write for a reader who has no background on the task and hasn't read the code, whether that's the user, a reviewer, or the next agent. Agents write most code now, so nobody holds the full background.

Write plainly and directly, in literal wording and complete sentences that are easy to follow. Avoid mannered prose, stock phrases, and jargon where plain words say the same thing, and don't compress sentences into fragments to save words.

Use sentence case for reader-facing text, including Markdown headings.

Don't hard-wrap Markdown prose.

## Documentation and instructions

Agents are the main readers of documentation, skills, instructions, and prompts. Both reading and reasoning cost tokens, so keep a sentence only when it saves more thinking than it costs to read, such as a decision agents would otherwise get wrong or work out again on every run. Simplify by removing decisions and branches rather than compressing sentences, and before adding a rule, check whether changing an existing one would do. Give the reason for a rule that isn't obvious, and state each fact once. Keep history and status in PRs and issues, and cut documentation in the same change that makes it stale.

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

## Project-specific rules

This repository is the source of `AGENTS.md` and the canonical payload. Edit canonical files here; consumers receive them through `bun standards sync`.

### Payloads and the generated AGENTS.md

`sync-standards.json` splits the payload into `core`, for repositories of any language, and `bun`, which Bun consumers get on top of core. Put a path in `bun` when it assumes a Bun workspace. `AGENTS.md` is generated from the payloads' parts in `agents-md/` down to its `## Project-specific rules` heading: edit the parts and run `bun run check:fix`, which regenerates that part. This repository's own rules are below the heading.

### Source-repository structure profile

This repository is not a `standards structure` consumer. Its root gate runs the local CLI instead of `standards check`, and `packages/standards-cli` is a published bin-only package with a SemVer version. The `source` profile in `packages/standards-cli/src/structure-profile.ts` pins these exceptions. When the repository's shape changes, update that profile and the root `check` and `check:fix` scripts together.

### Standards CLI bootstrap architecture

`packages/standards-cli` is exempt from the Effect standards. It must run through `bunx` before a consumer installs dependencies, so it uses plain async TypeScript and minimal runtime dependencies.

### Standards CLI subcommand vs. justfile recipe

Operator tooling with real logic, such as validation, credential resolution, provider calls, or structured output, becomes a tested `bun standards` subcommand. Justfile recipes stay one-line compositions of existing commands. Do not wrap a subcommand that is already a single obvious invocation.

### Dependency version holds

Declare template-wide holds as `ignore` entries in `.github/dependabot.base.yml`, each with a comment giving the reason and the lift condition. Never hold a version by closing Dependabot PRs or with `@dependabot ignore` comments. When a hold or held pin changes, update the hold entry and every affected pin in the root `package.json`, `template/package.json`, and the `biome.base.jsonc` schema URL together.

### Authoring the canonical Biome base

`biome.base.jsonc` enables every applicable rule domain, the recommended set, and applicable opt-in nursery and security rules at `error`. On Biome upgrades, adopt new rules at `error` and opt out deliberately.

### Skill descriptions

A skill's `description` is loaded into every session, so it says only when to use the skill, such as `Use when opening an issue or changing its title or description.` What the skill does belongs in its body.
