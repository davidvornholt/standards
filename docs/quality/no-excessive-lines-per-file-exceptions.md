# `noExcessiveLinesPerFile` exceptions

| File | Reason |
| --- | --- |
| `packages/standards-cli/src/cli.ts` | Zero-dependency bootstrap boundary shipped as one Bun executable. |
| `packages/standards-cli/src/cli.test.ts` | Black-box CLI contract suite sharing isolated filesystem fixtures and subprocess helpers. |

Each entry must also appear in the narrow override in `biome.base.jsonc`.
