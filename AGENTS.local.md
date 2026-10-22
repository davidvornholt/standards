# Project-specific rules

This repository is the source of `AGENTS.md` and the canonical payload. Edit canonical files here; consumers receive them through `bun standards sync`.

## Source-repository structure profile

This repository is not a `standards structure` consumer. Its root gate runs the local CLI instead of `standards check`, and `packages/standards-cli` is a published bin-only package with a SemVer version. The `source` profile in `packages/standards-cli/src/structure-profile.ts` pins these exceptions. When the repository's shape changes, update that profile and the root `check` and `check:fix` scripts together.

## Standards CLI bootstrap architecture

`packages/standards-cli` is exempt from the Effect standards. It must run through `bunx` before a consumer installs dependencies, so it uses plain async TypeScript and minimal runtime dependencies.

## Standards CLI subcommand vs. justfile recipe

Operator tooling with real logic, such as validation, credential resolution, provider calls, or structured output, becomes a tested `bun standards` subcommand. Justfile recipes stay one-line compositions of existing commands. Do not wrap a subcommand that is already a single obvious invocation.

## Dependency version holds

Declare template-wide holds as `ignore` entries in `.github/dependabot.base.yml`, each with a comment giving the reason and the lift condition. Never hold a version by closing Dependabot PRs or with `@dependabot ignore` comments. When a hold or held pin changes, update the hold entry and every affected pin in the root `package.json`, `template/package.json`, and the `biome.base.jsonc` schema URL together.

## Authoring the canonical Biome base

`biome.base.jsonc` enables every applicable rule domain, the recommended set, and applicable opt-in nursery and security rules at `error`. On Biome upgrades, adopt new rules at `error` and opt out deliberately.
