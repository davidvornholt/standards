---
name: database
description: Use when changing database schemas, migrations, database access, or database package structure. Keeps the Drizzle schema authoritative and migrations generated.
---

# Database and migrations

Databases default to Drizzle, and the Drizzle schema is the source of truth. Generate migrations from it with `drizzle-kit generate` instead of writing SQL files by hand. The migrator runs only files listed in Drizzle's migration journal, and Drizzle Kit diffs the schema against the snapshot of the last generated migration. So a hand-written file is either never applied or duplicated by the next generated migration. When a migration needs SQL the schema can't express, such as a data backfill or an exclusion constraint, create the file with `drizzle-kit generate --custom` and write the SQL there. That keeps it in the journal.

Unless a database is private to one app, its schema, migrations, Drizzle config, and scripts live in a dedicated package: `packages/db` for the primary database, and one package per additional database. Apps, workers, and migration runs then share one schema, and the canonical dev-database recipes find `DATABASE_URL` in `packages/db` by default.

When Effect code accesses PostgreSQL, it goes through `@effect/sql-pg`. Use the connection helpers that the project's `@<project>/db` package exports instead of wiring a `PgClient` inside an app, so every process connects with the same pool limits and type parsing.

The canonical justfile owns the local development database: `just dev-db-start`, `just dev-db-stop`, and `just dev-db-status` manage one Podman container named after the root package. Don't add a project script or compose file for it. A project once did, and its container claimed the same name with a different image and mounts, so each tool refused to manage the other's container.

`bun run` doesn't pass `.env.local` to the commands a script starts. Scripts that need `DATABASE_URL` load it explicitly, as in `"db:migrate": "bun --env-file=.env.local drizzle-kit migrate"`.
