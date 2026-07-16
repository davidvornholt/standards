# Review decisions

## STRUCTURE-001: Consumer workspace versions

Every workspace in a standards consumer is internal and must use version `0.0.0`. Versioned publishable workspaces are outside the consumer structure contract because consumers do not expose workspace packages as independently released artifacts.

## STRUCTURE-002: Supported workspace declarations

Workspace declarations must be arrays of literal paths or one-level `<dir>/*` patterns. Broader Bun glob patterns and object-shaped workspace schemas are rejected explicitly because the structure gate intentionally supports a small, deterministic consumer layout contract.

## SYNC-001: Checked-in sync policy hard cutover

Starting with CLI 0.7.0, `sync-standards.local.json` is the only standards-sync cadence and ref policy source. The canonical workflow and CLI do not consult `STANDARDS_AUTO_SYNC` or `STANDARDS_SYNC_REF`; consumers must upgrade the package and lockfile and materialize any required policy in the same migration change.
