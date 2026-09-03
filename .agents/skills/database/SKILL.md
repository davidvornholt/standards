---
name: database
description: Use when changing database schemas, migrations, database access, or database package structure. Keeps the Drizzle schema authoritative and migrations generated.
---

# Database & migrations

- Default to Drizzle when working with databases.
- When runtime database access is Effect-based and targets PostgreSQL, use `@effect/sql-pg` as the Postgres adapter, and prefer the shared `@<repo>/db` helpers over app-local PgClient wiring.
- Do not handwrite SQL migration files; generate them with Drizzle Kit from the schema source of truth.
- Unless a database is intentionally app-private, keep its schema, migrations, config, and scripts in a dedicated package — `packages/db` for the primary database, one package per database if there are several.
- The canonical justfile owns the local dev database container (`just dev-db-start`); never add a repo-local script for it.
- Script migrations as `"db:migrate": "bun --env-file=.env.local drizzle-kit migrate"`; plain `bun run` does not load `.env.local`.
