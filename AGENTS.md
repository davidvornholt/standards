# AGENTS.md

This file is the root operating contract for agents in this repository. Keep root instructions for non-negotiable constraints; put specialized workflows in `.agents/skills/*/SKILL.md`.

Quality gates (lint, types, tests, a11y) are deliberately strict so agents can verify changes mechanically instead of declaring them done. Strengthen gates when you can; never weaken one to make a change pass.

Check an expensive or irreversible operation's cheap preconditions before starting it, so work already certain to fail does so before paying its setup cost. This is distinct from validation, which must still gather and report all errors together.

## Research first

- Check whether the request conflicts with repo architecture or standards.
- Ask before broad product, UX, architectural, naming, workflow, scope, or business-logic decisions.
- Prefer cleaner architecture when justified. Do not preserve messy code only to avoid churn.

## Skill routing

Before generating code, inspect the `description` frontmatter for every local skill at `.agents/skills/<name>/SKILL.md`.

## Subagents

- Delegate liberally to subagents for work where only the conclusion matters — broad searches, stale-reference sweeps, verification passes, independent parallel changes. Spending extra tokens to keep the main context lean is the right trade in this repo.

## Package management

- Use Bun only.
- Add dependencies with `bun add`; do not manually edit dependency versions into `package.json`.
- A workspace must declare every package it imports directly. Do not rely on hoisted, transitive, or sibling-workspace dependencies.
- Workspaces that rely on Bun runtime or `bun:test` types must declare `@types/bun`. Do not add custom Bun ambient declaration shims when `@types/bun` is sufficient.

## Monorepo structure

- App-local code lives in `apps/*`; shared/foundational code lives in `packages/*`.
- Put code where ownership is clearest. Keep single-app code in the owning app unless there is an intentional shared contract.
- Package names must use the real project alias: `@<actual-project-name>/<package-name>`. Canonical packages synced from the template repo use the `@davidvornholt` scope instead; do not edit them locally — changes go to the template.
- Internal packages use version `"0.0.0"` and internal dependencies use `workspace:*`.
- Use package aliases for workspace imports. Never import another package through relative paths.
- Extend shared TypeScript config from `packages/typescript-config`; do not create standalone `tsconfig.json` files.
- Packages must define public APIs with `exports`.
- Do not add `index.ts` barrel files in apps, features, shared folders, or packages.

## Architecture boundaries

- Entrypoints route, parse initial inputs, wire Effect layers, and bridge to runtime/UI.
- Business logic belongs in app-local `src/features/*` or intentional shared packages.
- App-local shared infrastructure belongs in `src/shared/*`.
- Dependency flow is one-way: `entrypoint -> features -> shared -> packages`.
- Features may depend on `src/shared/*` and packages, but not sibling features.
- `src/shared/*` must not import from `src/features/*`; `packages/*` must not import from `apps/*`.
- Prefer colocated tests next to the files they protect.
- Code files should ideally not exceed 200 lines; split larger files into focused modules.
- If a file genuinely needs to exceed the line limit because it is static data, generated-style schema/config, broad test/config coverage, or otherwise clearer as a single boundary file, keep the exception explicit in `docs/quality/no-excessive-lines-per-file-exceptions.md`.

## Default shapes

- App code defaults to `src/app`, `src/features/<domain>/{schemas,errors,services,ui}`, and `src/shared/<module>`.
- Package code defaults to `src/<capability>.ts(x)` plus colocated tests, with deeper folders only for complex capabilities.

## Workspace scripts

- Workspace packages must expose `check-types`, `lint`, `lint:fix`, and `test` with `tsc --noEmit`, `biome check --error-on-warnings`, `biome check --write --error-on-warnings`, and `bun test`.
- Browser-rendered app workspaces with Playwright/Axe coverage must expose `test:a11y` as the browser a11y gate and declare `@axe-core/playwright` and `@playwright/test` directly. The script may wrap `playwright test` when it needs local service orchestration.
- Root scripts must include `test:a11y` delegating through Turbo to every workspace that defines a Playwright/Axe `test:a11y` task.
- Root scripts must include `check: turbo run lint check-types test build test:a11y` and `check:fix: turbo run lint:fix check-types test build test:a11y`.
- Operational scripts belong to the owning workspace. Put the real command in that workspace's `package.json`.
- Root convenience scripts must delegate through Turbo with an explicit package filter, such as `turbo run dev --filter @my-repository/admin`.
- Keep root `package.json` scripts minimal: cross-workspace quality gates plus narrowly useful filtered convenience aliases only.

## Linting

- Lint with Biome. `biome.jsonc` must be maximally strict: enable every applicable rule domain, the recommended set, and applicable opt-in nursery and security rules, all at `error`.
- Fix lint findings in the code. Never resolve them by downgrading or disabling rules globally, and never suppress with `biome-ignore` without a stated reason.
- Per-file overrides are the escape hatch of last resort: scope them to the narrowest paths and the specific rule that genuinely cannot apply.
- When upgrading Biome or when new rules become available, adopt them at `error` and opt out deliberately rather than opting in.

## Configuration and secrets

- Secret values live only in SOPS-encrypted YAML targets.
- Non-secret configuration lives in plain config next to its consumer. A value is secret if leaking it enables impersonation, data access, or cost; otherwise it is configuration.
- Each workspace under `apps/*` or `packages/*` maintains a `README.md` documenting every configuration value and secret it consumes — requiredness, behavior, defaults. Mirror the secret shape in the matching `*.example.yaml` (`secrets/dev.example.yaml`, `secrets/ci.example.yaml`, `infra/hosts/<host>/secrets.example.yaml`).

## TypeScript standards

- No `any`; use `unknown` plus Schema decoding where validation is needed.
- Use named exports and prefer inline exports, such as `export const value = ...`.
- Default exports are allowed only where framework conventions require them, such as Next.js `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, and `route.ts`.
- Use `import type` for type-only imports.
- Use `kebab-case` files/folders, `camelCase` variables/functions, and `PascalCase` types/classes.
- Prefer `const`, `readonly`, `ReadonlyArray<T>`, and arrow functions assigned to `const`. `function*` is allowed for Effect generators.
- Mark a property or parameter optional (`?`) only when a real call site omits it or its default is actually exercised. Do not add `?` defensively or for backwards compatibility.

## Effect standards

- Use Effect for application logic, async work, recoverable errors, and validation.
- Do not `throw` for expected failures; return typed Effect errors.
- Recoverable Effect errors must be specific `Data.TaggedError` classes with stable `_tag` values and actionable `message` fields.
- Internal logic should not use `async/await`; use `Effect.gen`.
- Prefer Effect combinators for Effectful branching when they make control flow clearer.

## Next.js notes

- Server Components, Route Handlers, and Server Actions may be `async`; bridge Effect programs with `await Effect.runPromise(program)`.
- Use Next.js Cache Components patterns. Do not add route segment config (`runtime`, `dynamic`, `revalidate`, etc.). Use `'use cache'` plus `cacheLife`/`cacheTag` for cacheable async data, and Suspense/request-time APIs for genuinely dynamic content.

## Frontend standards

- Meet WCAG 2.2 AA with semantic HTML, correct heading hierarchy, keyboard navigation, visible focus states, and non-color-only communication.
- Use framework metadata/document primitives for SEO and prefer server-rendered/indexable content when SEO matters.
- Use sentence case where sensible for reader-facing text, including UI text, button labels, command-style actions, and Markdown headings, while preserving proper nouns, acronyms, filenames, package names, and domain terms.
- Use browser hyphenation for long reader-facing text, and add manual soft hyphens only in curated display copy where wrapping needs help. Use `&shy;` in markup or `\u00AD` in string literals where entities are not decoded; avoid both in identifiers, URLs, form values, searchable data, tests, and accessibility labels.
- Define color tokens and authored CSS colors with `oklch(...)`.

## Accessibility testing

- Browser-rendered apps must have Playwright + Axe coverage asserting zero violations against the full WCAG 2.2 AA tag set.
- Keep the Axe scan helper and Playwright config factory in `packages/a11y-testing`; app-local `a11y/*.a11y.ts` specs stay thin lists of routes and states.
- Cover every reachable route and meaningful interaction states (open menus, dialogs, expanded/error states).

## State management

- Keep state as local as practical. Use React local state for component-owned UI state.
- Use Zustand by default for shared client-side UI/app state in React and Next.js.
- Do not use Zustand as a server-data cache. If client-side remote data needs caching, refetching, invalidation, pagination, optimistic updates, or mutation coordination, propose TanStack Query before building custom store logic.

## Testing

- Add or update tests for behavior you changed.
- UI/page wiring should have a small, meaningful test surface when logic, state, error, or empty-state behavior changes.
- Prefer tests that protect behavior, state transitions, data contracts, accessibility-relevant states, and regression-prone cases.
- Do not add tests that only pin trivial copy, labels, static literals, or states the type system already makes unrepresentable.

## Definition of done

Use this as a feedback loop.

1. Add or update tests for behavior you changed.
2. Search for stale references to changed concepts, names, paths, configuration, secrets, commands, public APIs, error types, or architectural patterns. Update docs and SOPS secret examples when needed.
3. Run `bun run check:fix` from the repo root for code changes. If it fails, read the full error, fix the root cause, and run it again.

For documentation-only changes, run a narrower verification when the full check would not add useful signal.

## Comments

- Prefer self-documenting code.
- Add comments only for non-obvious intent.

## Project-specific rules

This file is canonical and synced from the standards template — do not edit it
locally. Project-specific rules that extend this contract live in
`AGENTS.local.md`; add local guidance there instead.

@AGENTS.local.md
