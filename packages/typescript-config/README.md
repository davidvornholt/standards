# @davidvornholt/typescript-config

Shared strict TypeScript presets for standards monorepos.

## Presets

| Import | Use |
| --- | --- |
| `@davidvornholt/typescript-config/base` | Bun or framework-neutral TypeScript. |
| `@davidvornholt/typescript-config/next` | Next.js applications. |
| `@davidvornholt/typescript-config/react-library` | Browser-facing React packages. |
| `@davidvornholt/typescript-config/tanstack-start` | TanStack Start applications. |

The base preset enables strict type checking, bundler module resolution, isolated modules, JSON imports, Bun types, and `noEmit`. Framework presets extend it with their JSX, DOM, plugin, or Vite requirements.

## Usage

```json
{
  "extends": "@davidvornholt/typescript-config/next",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

Keep repository-specific paths and framework-generated includes in the consuming workspace. Do not copy the shared compiler options locally.

This package reads no configuration or secrets at runtime.
