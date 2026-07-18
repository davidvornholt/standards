# Project-specific rules

This is the standards template repo itself — the source of truth for `AGENTS.md` and the canonical payload. Changes to canonical files are made here directly (consumers receive them via `bun standards sync`).

## Compatibility decisions

- Breaking changes at consumer-facing boundaries are pre-approved, deciding the durable-boundary question in AGENTS.md once: prefer hard cutovers over transitional fallbacks, and document the breakage and migration in the PR body instead of pausing for approval.

## Source-repository structure profile

This repository is deliberately not a `standards structure` consumer: the root gate runs the local CLI (`structure --profile source`, then `dependabot --check` or `dependabot --write`, then `github --check`, then the Turbo gate) instead of a recursive `standards check`, and `packages/standards-cli` ships as a published bin-only package with a release SemVer version. The `source` profile in `packages/standards-cli/src/structure-profile.ts` pins exactly these exceptions, and the root `check`/`check:fix` scripts enforce it on this checkout. When the source repository's shape deliberately changes, update the profile and the root scripts in the same change — the gate failing on one without the other is the point.

## Dependency version holds

Template-wide dependency holds are declared as `ignore` entries in the canonical `.github/dependabot.base.yml`, each with a comment stating the reason and the lift condition. Never hold a version by closing Dependabot PRs or via `@dependabot ignore` comments — that is invisible per-repo state. When a hold or a held pin changes, update every affected pin (root `package.json`, `template/package.json`, the `biome.base.jsonc` schema URL) and the hold entry in the same change.

## Authoring the canonical Biome base

- `biome.base.jsonc` must be maximally strict: enable every applicable rule domain, the recommended set, and applicable opt-in nursery and security rules, all at `error`.
- When upgrading Biome or when new rules become available, adopt them at `error` and opt out deliberately rather than opting in.
