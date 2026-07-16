# AGENTS.md

This file is the root operating contract for agents in this repository. Keep root instructions for non-negotiable constraints; put specialized workflows in `.agents/skills/*/SKILL.md`.

Quality gates (lint, types, tests, a11y) are deliberately strict so agents can verify changes mechanically instead of declaring them done. Strengthen gates when you can; never weaken one to make a change pass. CI gating jobs must fail closed — a gate that errors or cannot find the run it depends on fails, never passes by default — and a deploy job must not run unless the quality gate passed for the exact commit being deployed.

Check an expensive or irreversible operation's cheap preconditions before starting it — unlike validation, which must still gather and report all errors together.

Treat duplication as a design signal: when a change needs to copy configuration, environment, or logic that another component already owns, stop — the responsibility is probably misplaced. Fix the owner or move the need instead of pasting the copy; if the duplication seems forced by the architecture, surface that instead of proceeding.

Do not build backwards compatibility by default: internal code has no external consumers, so migrate every call site and delete the old shape in the same change — no deprecated aliases, versioned copies, or compat-only optional parameters. Compatibility matters only at durable boundaries (persisted data, wire formats, deployed config/secret shapes, external consumers); when a change crosses one, surface the breakage and let the user decide.

## Research first

- Ask before broad product, UX, architectural, naming, workflow, scope, or business-logic decisions.
- Propose before changing CI workflows, quality gates, or canonical synced files, even to unblock a failure. The file class is the trigger, not whether the change feels architectural.
- Prefer cleaner architecture when justified. Do not preserve messy code only to avoid churn.

## Skill routing

Before generating code, inspect the `description` frontmatter for every local skill at `.agents/skills/<name>/SKILL.md`.

## Subagents

- Delegate liberally to subagents for work where only the conclusion matters — broad searches, stale-reference sweeps, verification passes, independent parallel changes. Spending extra tokens to keep the main context lean is the right trade in this repo.

## Pull requests

- Changes land on main through squash-merged PRs. The PR title becomes the commit subject on main, so it must be a Conventional Commit subject (`<type>(scope): <imperative description>`); CI lints it. Branch commit messages carry no format requirement.

## Package management

- Use Bun only.
- Add dependencies with `bun add`; do not manually edit dependency versions into `package.json`.
- Workspaces that rely on Bun runtime or `bun:test` types must declare `@types/bun`, not custom ambient declaration shims.

## Monorepo structure

- App-local code lives in `apps/*`; shared/foundational code lives in `packages/*`.
- Put code where ownership is clearest. Keep single-app code in the owning app unless there is an intentional shared contract.
- Package names must use the real project alias: `@<actual-project-name>/<package-name>`. Canonical packages synced from the template repo use the `@davidvornholt` scope instead; do not edit them locally — changes go to the template.
- Use package aliases for workspace imports. Never import another package through relative paths.
- Do not add `index.ts` barrel files in apps, features, shared folders, or packages.

## Architecture boundaries

- Entrypoints route, parse initial inputs, wire Effect layers, and bridge to runtime/UI.
- Business logic belongs in app-local `src/features/*` or intentional shared packages.
- App-local shared infrastructure belongs in `src/shared/*`.
- Dependency flow is one-way: `entrypoint -> features -> shared -> packages`.
- Features may depend on `src/shared/*` and packages, but not sibling features.
- `src/shared/*` must not import from `src/features/*`; `packages/*` must not import from `apps/*`.
- Prefer colocated tests next to the files they protect.
- A file genuinely clearer as a single boundary file — static data, generated-style schema/config, broad test/config coverage — may exceed the 200-line lint limit via a scoped `biome.jsonc` override plus an entry in `docs/quality/no-excessive-lines-per-file-exceptions.md`.

## Default shapes

- App code defaults to `src/app`, `src/features/<domain>/{schemas,errors,services,ui}`, and `src/shared/<module>`.
- Package code defaults to `src/<capability>.ts(x)` plus colocated tests, with deeper folders only for complex capabilities.

## Workspace scripts

- Operational scripts belong to the owning workspace. Put the real command in that workspace's `package.json`, and keep root scripts minimal: the quality gates plus narrowly useful filtered Turbo convenience aliases.

## Linting

- Fix lint findings in the code. Never resolve them by downgrading or disabling rules globally, and never suppress with `biome-ignore` without a stated reason.
- Per-file overrides are the escape hatch of last resort: scope them to the narrowest paths and the specific rule that genuinely cannot apply.

## Configuration and secrets

- Secret values live only in SOPS-encrypted YAML targets.
- Non-secret configuration lives in plain config next to its consumer. A value is secret if leaking it enables impersonation, data access, or cost; otherwise it is configuration.
- Each workspace under `apps/*` or `packages/*` maintains a `README.md` documenting every configuration value and secret it consumes — requiredness, behavior, defaults. Mirror the secret shape in the matching `*.example.yaml` (`secrets/dev.example.yaml`, `secrets/ci.example.yaml`, `infra/hosts/<host>/secrets.example.yaml`).

## TypeScript standards

- Type untrusted input as `unknown` and validate with Schema decoding.
- Prefer inline exports, such as `export const value = ...`. Default exports are allowed only where framework conventions require them (Next.js `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `route.ts`), via a scoped lint override.
- Use `kebab-case` file and folder names.
- Prefer `readonly`, `ReadonlyArray<T>`, and arrow functions assigned to `const`. `function*` is allowed for Effect generators.
- Mark a property or parameter optional (`?`) only when a real call site omits it or its default is actually exercised. Do not add `?` defensively or for backwards compatibility.

## Effect standards

- Use Effect for application logic, async work, recoverable errors, and validation.
- Do not `throw` for expected failures; return typed Effect errors.
- Recoverable Effect errors must be specific `Data.TaggedError` classes with stable `_tag` values and actionable `message` fields.
- Internal logic should not use `async/await`; use `Effect.gen`.
- Prefer Effect combinators for Effectful branching when they make control flow clearer.

## Writing style

- Use sentence case where sensible for reader-facing text, including UI text, button labels, command-style actions, and Markdown headings, while preserving proper nouns, acronyms, filenames, package names, and domain terms.
- Prefer self-documenting code; comment only non-obvious intent.
- Do not hard-wrap Markdown prose; keep each paragraph or list item on one logical line.

## Testing

- UI/page wiring should have a small, meaningful test surface when logic, state, error, or empty-state behavior changes.
- Prefer tests that protect behavior, state transitions, data contracts, accessibility-relevant states, and regression-prone cases.
- Do not add tests that only pin trivial copy, labels, static literals, or states the type system already makes unrepresentable.

## Definition of done

Use this as a feedback loop.

1. Add or update tests for behavior you changed.
2. Search for stale references to changed concepts, names, paths, configuration, secrets, commands, public APIs, error types, or architectural patterns. Update docs and SOPS secret examples when needed.
3. Run `bun run check:fix` from the repo root for code changes. If it fails, read the full error, fix the root cause, and run it again.

For documentation-only changes, run a narrower verification when the full check would not add useful signal.

## Project-specific rules

This file is canonical and synced from the standards template — do not edit it locally. Project-specific rules that extend this contract live in `AGENTS.local.md`; add local guidance there instead.

@AGENTS.local.md
