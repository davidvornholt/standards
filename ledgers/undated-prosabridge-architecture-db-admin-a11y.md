# Second review loop: architecture, DB, admin a11y

- Baseline: `7b06695` passed `bun run check:fix` from cache.
- Findings in scope:
  - Shared backend modules import feature-owned errors.
  - Translation job feature test imports app layer.
  - Admin feature components import `@/app/actions`.
  - Credit reservation/refund domain failures are thrown inside DB transactions and wrapped as `BackendDatabaseError`.
  - Admin Playwright a11y only covers unauthenticated auth pages.

## Fixes

- Moved shared backend auth/storage/Okapi errors into `apps/backend/src/shared/errors.ts`; kept feature compatibility aliases without barrel re-exports.
- Moved the Bible translations route integration test from the translation-jobs feature folder into `apps/backend/src/app`.
- Moved organization and translation server actions into their owning feature server modules; removed `apps/admin/src/app/actions.ts`.
- Changed credit reservation/refund transaction checks to return typed result objects and fail outside `runQuery`, preserving domain errors.
- Added authenticated admin a11y coverage for the real app shell through a Playwright-only, non-production session fixture.
- Added `ADMIN_A11Y_SESSION_EMAIL` and `PLAYWRIGHT_A11Y` to admin docs/examples and Turbo a11y env tracking.

## Verification

- `bun run --filter @prosabridge/backend test src/features/translation-jobs/persistence/translation-jobs-store-writers-source.test.ts`
- `bun run --filter @prosabridge/admin test src/features/organizations/server/actions.test.ts src/features/translations/server/actions.test.ts src/shared/server/auth/admin-session.test.ts`
- `CI=true bun run --filter @prosabridge/admin test:a11y`
- `bun run check:fix`
