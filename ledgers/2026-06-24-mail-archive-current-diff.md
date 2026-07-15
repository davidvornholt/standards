# Review loop ledger: current diff

## Scope

- 2026-06-24 17:46:55 +0200: User request: run a review loop against the current diff.
- 2026-06-24 17:46:55 +0200: Base scope: all modified files in `git status --short`, plus untracked `apps/web/src/shared/text/services/soft-hyphen.ts`.
- 2026-06-24 17:46:55 +0200: Validation gate command: `bun run check:fix`.
- 2026-06-24 17:46:55 +0200: Gate result: passed. Turbo reported 17 successful tasks, including lint:fix, check-types, tests, build, and test:a11y.

## Passes

- 2026-06-24 17:51:22 +0200: Pass 1 reviewed the full current diff plus untracked `apps/web/src/shared/text/services/soft-hyphen.ts`.
  - Reviewers invoked: accessibility (`019efa50-9723-7a10-ac49-345de3dfad39`), architecture/types (`019efa50-9770-7a40-9131-5ffc99fa64fb`), tests/docs (`019efa50-9798-7b02-8991-75e3ff194f40`), catch-all (`019efa50-97bd-7011-85c0-1fa5810ce59c`).
  - Invocation status: all completed; retry count 0.
  - Checks run by orchestrator for this pass: `bun run check:fix` passed before review. Focused validation after reviewer output: TSX/React SSR probe confirmed JSX attribute `&shy;` decodes to U+00AD; official `gesetze-im-internet.de` DDG references checked for `§ 5 DDG` and `§ 7 DDG`.

## Findings

- RL-001 | 2026-06-24 17:51:22 +0200 | Blocking | accessibility | `apps/web/src/features/what-we-offer/apply/presentation/components/apply-form-fields.tsx:51`, `apps/web/src/features/what-we-offer/apply/models/form-schema.ts:119`, `packages/ui/src/form.tsx:111` | Form labels, descriptions, and validation messages contain manual soft hyphens, which are layout-only characters in accessible names/descriptions rather than curated display copy. | Disposition: pending worker fix. | Verification: pending.
- RL-002 | 2026-06-24 17:51:22 +0200 | Blocking | tests/docs | `apps/web/src/features/formal/presentation/screens/imprint-screen.tsx:12`, `apps/web/src/features/formal/presentation/screens/imprint-screen.tsx:79` | Public imprint still cites the former TMG provisions; current source law uses DDG after TMG went out of force on 2024-05-14. | Disposition: pending worker fix. | Verification: pending.
- RL-003 | 2026-06-24 17:51:22 +0200 | Non-Blocking | tests/docs | `apps/web/src/features/what-we-offer/apply/models/form-schema.test.ts:5`, `apps/web/src/features/what-we-offer/apply/models/form-schema.test.ts:74` | Tests import the same `softHyphen` helper as production for expected validation messages, so the assertion would move with a helper regression. | Disposition: pending worker fix; likely resolved by removing soft hyphens from validation messages. | Verification: pending.
- RL-004 | 2026-06-24 17:51:22 +0200 | Blocking | catch-all | `apps/web/src/features/admin/presentation/screens/applications-screen.tsx:22`, `apps/web/src/features/what-we-offer/apply/presentation/components/apply-form-fields.tsx:51` | Claimed JSX string attributes render visible `&shy;` text. | Disposition: discarded. | Reason: focused TSX compiler and React SSR probes showed JSX attributes and text children decode `&shy;` to U+00AD before rendering; the finding only applies to plain TypeScript string literals, which already use `softHyphen` in the changed data/constants. | Verification: `bun -e` SSR probe rendered `Schul­anmeldungen` with code point `0xad`, not `&amp;shy;`.
- 2026-06-24 17:55:02 +0200: Worker `019efa54-9b75-7a62-91f1-50b94b80fb40` completed fixes for RL-001, RL-002, and RL-003.
  - RL-001 disposition update: fixed. Reason: `apply-form-fields.tsx`, `form-schema.ts`, and `form-schema.test.ts` no longer have a net diff; focused `rg "softHyphen|&shy;|\\u00AD"` across those files returned no matches.
  - RL-002 disposition update: fixed. Reason: `imprint-screen.tsx` now cites `§ 5 DDG` and replaces stale TMG liability references with current DDG/DSA wording; focused `rg` for TMG references across `apps/web/src` returned no matches.
  - RL-003 disposition update: fixed. Reason: the production validation messages no longer use `softHyphen`, and the tests no longer import it.
  - Verification after worker: worker reported `bun test apps/web/src/features/what-we-offer/apply/models/form-schema.test.ts` passed and scoped Biome passed. Orchestrator reran `bun run check:fix`; it passed with 17 successful Turbo tasks, including lint:fix, check-types, tests, build, and test:a11y.
- 2026-06-24 17:57:48 +0200: Pass 2 reviewed the worker delta and prior finding dispositions.
  - Reviewer invoked: unscoped convergence reviewer (`019efa57-f319-7cf2-8a58-f0981a7ea235`).
  - Invocation status: completed; retry count 0.
  - Delta reviewed: `imprint-screen.tsx` net DDG/DSA wording update, apply-form files verified as no net diff, untracked `soft-hyphen.ts` checked only for prior-finding context.
  - Checks run by reviewer: scoped `git diff`, scoped `git diff --check`, `rg` for stale `TMG`/`Telemedien*`, `rg` for `&shy;`/`\\u00AD` in apply-form label/error files, and legal source cross-checks.
  - Result: no Blocking Findings, no Non-Blocking Findings, no Nits. Loop clean.
