---
name: database
description: Use when changing database schemas, migrations, database access, or database package structure. Keeps the Drizzle schema authoritative and migrations generated.
---

# Database and migrations

Databases default to Drizzle, and the Drizzle schema is the source of truth. Generate migrations from it with `drizzle-kit generate`, and use `drizzle-kit generate --custom` for SQL the schema can't express.

Unless a database is private to one app, its schema, migrations, Drizzle config, and scripts live in a dedicated package: `packages/db` for the primary database, and one package per additional database.

Effect code accesses PostgreSQL through `@effect/sql-pg`, using the connection helpers from the project's `@<project>/db` package rather than its own `PgClient`.

The canonical justfile owns the local development database (`just dev-db-start`). Don't add a project script or compose file for it.

`bun run` doesn't load `.env.local`, so scripts that need `DATABASE_URL` load it explicitly, as in `"db:migrate": "bun --env-file=.env.local drizzle-kit migrate"`.
