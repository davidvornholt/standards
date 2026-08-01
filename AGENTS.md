# AGENTS.md

This file is the root operating contract for agents in this repository. Keep root instructions for non-negotiable constraints; put specialized workflows in `.agents/skills/*/SKILL.md`.

Never weaken a quality gate (lint, types, tests, a11y) to make a change pass; strengthen one when you can. CI gating jobs must fail closed — a gate that errors or cannot find the run it depends on fails, never passes by default — and a deploy job must not run unless the quality gate passed for the exact commit being deployed.

Check an expensive or irreversible operation's cheap preconditions before starting it — unlike validation, which must still gather and report all errors together.

When a change needs to copy configuration, environment, or logic another component already owns, fix the owner or move the need instead of pasting the copy. If the architecture seems to force the duplication, surface that instead of proceeding.

Do not build backwards compatibility by default: migrate every call site and delete the old shape in the same change — no deprecated aliases, versioned copies, or compat-only optional parameters. Compatibility matters only at durable boundaries (persisted data, wire formats, deployed config/secret shapes, external consumers); when a change crosses one, surface the breakage and let the user decide.

## Research first

- Ask before broad product, UX, architectural, naming, workflow, scope, or business-logic decisions.
- Propose before changing CI workflows, quality gates, or canonical synced files, even to unblock a failure. The file class is the trigger, not whether the change feels architectural.
- Prefer cleaner architecture when justified. Do not preserve messy code only to avoid churn.

## Writing for the decider

Questions, issue descriptions, and pull request descriptions are read by someone who directs product intent and has read none of the code. They decide from what you wrote whether work is worth doing, continuing, or fixing. Every agent writes them to this standard, whatever tool, skill, or workflow it is running under.

- Lead with what is at stake, as product behavior, cost, risk, or effort. For an issue: what goes wrong in practice, who it affects, and what it costs to leave alone. For a pull request: what changes about the product's behavior and why it was worth doing. For a question: where each option leads, with one recommended and the reason given. Restating what the code does is none of these.
- Carry the background the reader needs. Where following it depends on how some other part of the system already works, explain that part from scratch in the same plain terms. Never assume prior knowledge of any part of the codebase.
- Keep sentences short and give each one a single idea. Technical terms are allowed and often clearer than the alternative: name the thing, then say in plain words what it is the first time it appears. Replacing a name with a long description is not plain language; it makes the sentence harder to follow, not easier.
- Keep the technical evidence, file references, and verification below that opening, where the reader who needs them will look.

## Skill routing

Before generating code, inspect the `description` frontmatter for every local skill at `.agents/skills/<name>/SKILL.md`.

## Pull requests and issues

- Changes land on main through squash-merged PRs. The PR title becomes the commit subject on main, so it must be a Conventional Commit subject (`<type>(scope): <imperative description>`). Branch commit messages carry no format requirement.
- Every issue and pull request description opens with the statement "Writing for the decider" requires, before any other section.

## Package management

- Use Bun only.
- Add dependencies with `bun add`; do not manually edit dependency versions into `package.json`.
- Workspaces that rely on Bun runtime or `bun:test` types must declare `@types/bun`, not custom ambient declaration shims.

## Monorepo structure

- App-local code lives in `apps/*`; shared/foundational code lives in `packages/*`. Keep single-app code in the owning app unless there is an intentional shared contract.
- Package names must use the real project alias: `@<actual-project-name>/<package-name>`. Canonical packages synced from the template repo use the `@davidvornholt` scope instead; do not edit them locally — changes go to the template.
- Use package aliases for workspace imports. Never import another package through relative paths.
- Do not add `index.ts` barrel files.

## Architecture boundaries

- Entrypoints route, parse initial inputs, wire Effect layers, and bridge to runtime/UI.
- Business logic belongs in app-local `src/features/*` or intentional shared packages; app-local shared infrastructure belongs in `src/shared/*`.
- Dependency flow is one-way: `entrypoint -> features -> shared -> packages`. Features must not import sibling features.
- Prefer colocated tests next to the files they protect.
- A file genuinely clearer as a single boundary file — static data, generated-style schema/config, broad test/config coverage — may exceed the 200-line lint limit via a scoped `biome.jsonc` override plus an entry in `docs/quality/no-excessive-lines-per-file-exceptions.md`.

## Default shapes

- App code defaults to `src/app`, `src/features/<domain>/{schemas,errors,services,ui}`, and `src/shared/<module>`.
- Package code defaults to `src/<capability>.ts(x)` plus colocated tests, with deeper folders only for complex capabilities.

## Workspace scripts

- Operational scripts belong to the owning workspace's `package.json`. Keep root scripts minimal: the quality gates plus narrowly useful filtered Turbo convenience aliases.
- Operator workflows that span the repo rather than one workspace — secrets management, derived dev env generation — live in the canonical root `justfile`. Repo-specific recipes and modules belong in a repo-owned `local.just`, which the canonical justfile imports when present.

## Linting

- Fix lint findings in the code, never by downgrading or disabling rules globally, and never with an inline Biome suppression that lacks a stated reason.
- Per-file overrides are the escape hatch of last resort: narrowest path, specific rule that genuinely cannot apply.

## Configuration and secrets

- Secret values live only in SOPS-encrypted YAML targets. A value is secret if leaking it enables impersonation, data access, or cost; otherwise it is configuration and lives in plain config next to its consumer.
- Each workspace under `apps/*` or `packages/*` maintains a `README.md` documenting every configuration value and secret it consumes — requiredness, behavior, defaults. Mirror the secret shape in the matching `*.example.yaml` (`secrets/dev.example.yaml`, `secrets/ci.example.yaml`, `infra/hosts/<host>/secrets.example.yaml`).
- Dev environment declarations are workspace-keyed (`apps.<name>`, `packages.<name>`) across three layers: tracked configuration in `config/dev.yaml`, literal dev secrets plus broker-reference policy in the SOPS-encrypted `secrets/dev.yaml`, and per-developer/per-machine overrides in the gitignored plain `config/dev.local.yaml`, which may override both. A plain configuration layer may reference an authorized broker-owned S3 pair in another SOPS target, so the generated `.env.local` can also contain values resolved from that target without copying them into `secrets/dev.yaml`. A key never lives in both tracked layers. `just dev-env-generate` composes the complete effective dev environment; never edit generated env files by hand.
- Provider credentials (Cloudflare API tokens, GitHub automation credentials) are minted with `bun standards creds`, which writes values directly into SOPS targets — do not ask the operator to create tokens in provider dashboards for needs the broker covers; see the declarative-infra skill's secrets reference.

## TypeScript standards

- Type untrusted input as `unknown` and validate with Schema decoding.
- Prefer inline exports, such as `export const value = ...`. Default exports are allowed only where framework conventions require them (Next.js `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `route.ts`), via a scoped lint override.
- Use `kebab-case` file and folder names.
- Prefer `readonly`, `ReadonlyArray<T>`, and arrow functions assigned to `const`. `function*` is allowed for Effect generators.
- Mark a property or parameter optional (`?`) only when a real call site omits it or its default is actually exercised; never defensively.

## Effect standards

- Required for async work, concurrency, retries, timeouts, resource acquisition, cancellation, and injected dependencies; at service boundaries the error and requirement channels are the contract.
- Not required for total synchronous logic or UI components, which stay plain and consume Effect at the boundary.
- Never `throw` for expected failures; return typed Effect errors. Recoverable errors are `Data.TaggedError` classes with stable `_tag` values and actionable `message` fields.
- A workspace may opt out wholesale only for a stated architectural reason recorded in `AGENTS.local.md`; do not mix idioms inside one workspace.

## Writing style

- Use sentence case for reader-facing text — UI copy, labels, command-style actions, Markdown headings — preserving proper nouns, acronyms, filenames, package names, and domain terms.
- Prefer self-documenting code; comment only non-obvious intent.
- Do not hard-wrap Markdown prose; keep each paragraph or list item on one logical line.

## Testing

- Test behavior, state transitions, data contracts, accessibility-relevant states, and regression-prone cases — including UI/page wiring when its logic, state, error, or empty-state behavior changes.
- Do not add tests that only pin trivial copy, labels, static literals, or states the type system already makes unrepresentable.

## Definition of done

1. Add or update tests for behavior you changed.
2. Search for stale references to changed concepts, names, paths, configuration, secrets, commands, public APIs, error types, or architectural patterns. Update docs and SOPS secret examples when needed.
3. Run `bun run check:fix` from the repo root for code changes. If it fails, read the full error, fix the root cause, and run it again.

For documentation-only changes, run a narrower verification when the full check would not add useful signal.

## Project-specific rules

This file is canonical and synced from the standards template — do not edit it locally. Project-specific rules that extend this contract live in `AGENTS.local.md`; add local guidance there instead.

@AGENTS.local.md
