---
name: database
description: Drizzle-first database architecture and migration workflow for this monorepo. Use when interacting with a database, changing schema definitions, generating or running migrations, placing database code, or wiring db:* scripts.
---

# Database & migrations

Apply these rules whenever work touches database schemas, Drizzle config, migration files, or database package structure.

## Defaults

- Default to Drizzle for schema definition, migration generation, and database migration execution unless the user explicitly instructs otherwise.
- When runtime database access is Effect-based and targets PostgreSQL, use `@effect/sql-pg` as the Postgres adapter. Prefer the shared `@<repo>/db` helpers over creating app-local PgClient wiring.
- Do not handwrite SQL migration files. Generate migrations with Drizzle Kit from the schema source of truth.
- Do not wire application runtime code to auto-run migrations unless the user explicitly requests that architecture.

## Workspace placement

- Unless a database is intentionally app-private, keep its Drizzle schema, migrations, config, and scripts in a dedicated package under `packages/*`.
- Prefer `packages/db` for the primary shared database.
- If the repository has more than one independent database or bounded context, create one package per database under `packages/*` such as `packages/db`, `packages/auth-db`, or `packages/analytics-db`.
- Keep Drizzle files inside an app only when that database is truly app-private and not intended to be reused across workspaces.

## Script ownership

- Database commands such as `db:generate` and `db:migrate` must live in the database-owning workspace package such as `packages/db/package.json`.
- The root `package.json` should call workspace-owned database scripts through Turbo wrappers such as `turbo run db:generate --filter=@my-repository/db`, replacing `@my-repository` with the real project alias in this repo.

## Drizzle conventions

- Keep `drizzle.config.ts` in the database-owning package.
- Keep generated SQL under that workspace's `drizzle/` directory.
- Commit generated migrations together with the matching `drizzle/meta/` journal files.
- The database-owning workspace must keep a Drizzle-supported driver installed for `drizzle-kit migrate`. For Postgres, valid examples include `pg`, `postgres`, `@neondatabase/serverless`, and `@vercel/postgres`.

## Required workflow

After changing schema definitions:

1. Run the workspace-owned `db:generate` script to create the migration.
2. Review the generated SQL.
3. Run the workspace-owned `db:migrate` script, which should call `drizzle-kit migrate`, against the target database.

## Source of truth

- Application runtime schema setup must not drift from generated Drizzle migrations.
- Apps should consume exported schema and database utilities from the database package instead of maintaining parallel schema definitions.
- Prefer Drizzle Kit-managed migrations over parallel hand-maintained SQL strings or ad hoc runtime migration wrappers.
