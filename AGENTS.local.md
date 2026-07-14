# Project-specific rules

This is the standards template repo itself — the source of truth for `AGENTS.md` and the canonical payload. Changes to canonical files are made here directly (consumers receive them via `bun standards sync`).

The source-only `packages/standards-release/scripts/classify-release.ts` executable and its dependency-free helper closure are an additional Effect exception because they run before repository dependencies are installed. This boundary may use explicit result values, raw Promises, and boundary throws, must not import third-party packages, and may only classify a release declaration. All other release tooling, including packing, registry inspection, publishing decisions, and GitHub Release reconciliation, follows the Effect and tagged-error rules in `AGENTS.md`.

The standards source root is the sole exception to the internal-dependency `workspace:*` rule: root `package.json` must declare `@davidvornholt/standards` at the exact published CLI version. Bun resolves that exact declaration to the local workspace, while the checked-in sync preflight requires the same exact published-version dependency shape used by consumers.
