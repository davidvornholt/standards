# `noExcessiveLinesPerFile` exceptions

| File | Reason |
| --- | --- |
| `packages/standards-cli/src/cli.ts` | Zero-dependency bootstrap boundary shipped as one Bun executable. |
| `packages/standards-cli/src/cli.test.ts` | Black-box CLI contract suite sharing isolated filesystem fixtures and subprocess helpers. |
| `packages/standards-cli/src/automation-proof.ts` | Generated-style persisted evidence schema whose exact-field validators are clearer beside the public proof contract. |
| `packages/standards-cli/src/automation-verify.ts` | GitHub administrator verification boundary that records one cohesive, auditable capability snapshot. |
| `packages/standards-cli/src/automation-delivery-verify.ts` | Linear source-to-deployment evidence chain kept together so every exact-run invariant remains auditable. |
| `packages/standards-cli/src/structure-policy.test.ts` | State-machine contract suite sharing complete legacy, partial-isolation, and full-isolation fixtures. |
| `packages/standards-cli/src/structure-secrets.ts` | Broad static validation boundary that gathers every SOPS target, example, recipient, and migration problem in one pass. |
| `packages/standards-cli/src/sync-policy-isolation.ts` | Generated-style schema validator for the two complete purpose-isolation objects and their cross-field invariants. |

Each entry must also appear in the narrow override in `biome.base.jsonc`.
