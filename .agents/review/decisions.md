# Review decisions

## STRUCTURE-001: Consumer workspace versions

Every workspace in a standards consumer is internal and must use version `0.0.0`. Versioned publishable workspaces are outside the consumer structure contract because consumers do not expose workspace packages as independently released artifacts.

## STRUCTURE-002: Supported workspace declarations

Workspace declarations must be arrays of literal paths or one-level `<dir>/*` patterns. Broader Bun glob patterns and object-shaped workspace schemas are rejected explicitly because the structure gate intentionally supports a small, deterministic consumer layout contract.

## SYNC-001: Checked-in sync policy hard cutover

Starting with CLI 0.7.0, `sync-standards.local.json` is the only standards-sync cadence and ref policy source. The canonical workflow and CLI do not consult `STANDARDS_AUTO_SYNC` or `STANDARDS_SYNC_REF`; consumers must upgrade the package and lockfile and materialize any required policy in the same migration change.

## DEPENDABOT-001: Deliberately lean local overlay

The repo-owned Dependabot overlay is additive but intentionally not a general policy override. It may define new ecosystem update blocks, top-level private registries, and `ignore` or `registries` additions on a canonical normalized target. Matching blocks reject labels, groups, cooldowns, pull-request limits, and every other policy key; broader per-repository policy must be proposed as an explicit seam decision.

## POLLER-001: Shared service identity risk

The fix poller and its approved Codex runs may share one host service identity and HOME. The poller removes its direct GitHub token variables before launching Codex, but the approved run can still read that identity's other ambient credentials and logged-in tool state. This credential visibility is an accepted risk because only an admin- or maintain-approved exact issue revision or pull-request head may run, and the approval binding is revalidated before publication. The host infrastructure repository owns the identity, PATH, token wiring, lingering, and declarative unit deployment; do not describe the Codex process as credential-isolated.

## RELEASE-001: Installed manifest version asserts CLI capability

Under the frozen non-hostile-consumer threat model, the installed `@davidvornholt/standards` manifest version plus the frozen lockfile is the capability assertion. The consumer already controls that dependency and executes its code, so extra package-name, bin, or capability probes do not establish official identity; defending against a falsely versioned or malicious substitution is out of scope.

## TOOLING-001: Root-owned Biome pin

`@biomejs/biome` is pinned only at the repository root (and `template/package.json` for consumers); workspaces deliberately do not declare it. Workspace lint scripts and tests resolve Biome through root-hoisted resolution, and a missing install fails fast with a resolution error. Reviews must not request per-workspace `@biomejs/biome` declarations; the pin moves with the root/template dependency-hold policy.

## GITHUB-SETTINGS-001: One read-only settings PAT

The isolated GitHub settings job uses one repository-scoped fine-grained PAT with read-only Administration and Issues access. Issues read exposes private issue content beyond the declared-label metadata the checker needs, but that read-only expansion is an accepted tradeoff to keep one credential route instead of adding a second token-selection mechanism. The acceptance depends on the PAT remaining repository-scoped, SOPS-encrypted, isolated from repository-controlled executable code, and free of write permissions. A private-repository probe on PR #94 confirmed that an Administration-plus-Metadata PAT can read merge settings through GraphQL but receives `FORBIDDEN` for `repository.labels`, so GraphQL does not provide a Metadata-only label path; revisit this decision if GitHub changes that permission boundary.
