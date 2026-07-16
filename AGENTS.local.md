# Project-specific rules

This is the standards template repo itself — the source of truth for `AGENTS.md` and the canonical payload. Changes to canonical files are made here directly (consumers receive them via `bun standards sync`).

## Compatibility decisions

- Breaking changes at consumer-facing boundaries are pre-approved, deciding the durable-boundary question in AGENTS.md once: prefer hard cutovers over transitional fallbacks, and document the breakage and migration in the PR body instead of pausing for approval.

## Authoring the canonical Biome base

- `biome.base.jsonc` must be maximally strict: enable every applicable rule domain, the recommended set, and applicable opt-in nursery and security rules, all at `error`.
- When upgrading Biome or when new rules become available, adopt them at `error` and opt out deliberately rather than opting in.
