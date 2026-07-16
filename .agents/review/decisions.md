# Review decisions

## STRUCTURE-001: Consumer workspace versions

Every workspace in a standards consumer is internal and must use version `0.0.0`. Versioned publishable workspaces are outside the consumer structure contract because consumers do not expose workspace packages as independently released artifacts.

## STRUCTURE-002: Supported workspace declarations

Workspace declarations must be arrays of literal paths or one-level `<dir>/*` patterns. Broader Bun glob patterns and object-shaped workspace schemas are rejected explicitly because the structure gate intentionally supports a small, deterministic consumer layout contract.
