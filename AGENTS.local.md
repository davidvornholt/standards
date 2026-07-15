# Project-specific rules

This is the standards template repo itself — the source of truth for `AGENTS.md` and the canonical payload. Changes to canonical files are made here directly (consumers receive them via `bun standards sync`).

## Authoring the canonical Biome base

- `biome.base.jsonc` must be maximally strict: enable every applicable rule domain, the recommended set, and applicable opt-in nursery and security rules, all at `error`.
- When upgrading Biome or when new rules become available, adopt them at `error` and opt out deliberately rather than opting in.
