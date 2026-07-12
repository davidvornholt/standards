---
name: database
description: Drizzle-first database architecture and migration workflow for this monorepo. Use when touching database schemas, migrations, or database package structure.
---

# Database & migrations

- Default to Drizzle when working with databases.
- When runtime database access is Effect-based and targets PostgreSQL, use `@effect/sql-pg` as the Postgres adapter, and prefer the shared `@<repo>/db` helpers over app-local PgClient wiring.
- Do not handwrite SQL migration files; generate them with Drizzle Kit from the schema source of truth.
- Do not wire application runtime code to auto-run migrations unless the user explicitly requests that architecture.
- Unless a database is intentionally app-private, keep its schema, migrations, config, and scripts in a dedicated package — `packages/db` for the primary database, one package per database if there are several.
