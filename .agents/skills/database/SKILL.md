---
name: database
description: Drizzle-first database architecture and migration workflow for this monorepo. Use when touching database schemas, migrations, or database package structure.
---

# Database & migrations

- Default to Drizzle when working with databases.
- When runtime database access is Effect-based and targets PostgreSQL, use `@effect/sql-pg` as the Postgres adapter, and prefer the shared `@<repo>/db` helpers over app-local PgClient wiring.
- Do not handwrite SQL migration files; generate them with Drizzle Kit from the schema source of truth.
- Unless a database is intentionally app-private, keep its schema, migrations, config, and scripts in a dedicated package — `packages/db` for the primary database, one package per database if there are several.
- The canonical justfile already owns the local dev database container: `just dev-db-start` / `dev-db-stop` / `dev-db-status` manage a Podman PostgreSQL instance shaped by `DATABASE_URL` from `packages/db/.env.local` (declare the value in `config/dev.yaml`, generate with `just dev-env-generate`). Never add a repo-local script that manages its own dev database container.
- Script migrations as `"db:migrate": "bun --env-file=.env.local drizzle-kit migrate"`; plain `bun run` does not load `.env.local` into Drizzle Kit.
