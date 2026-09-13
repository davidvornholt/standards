set dotenv-load := false

mod secrets 'secrets.just'

# Repo-specific recipes and modules extend this canonical file from a
# repo-owned local.just; this file is synced and must not be edited locally.

import? 'local.just'

default:
    @just --list

# Compose each workspace's .env.local from config/dev.yaml, encrypted secrets/dev.yaml, local overrides, and authorized broker-owned S3 pairs referenced by the plain layers
dev-env-generate:
    bun standards dev-env

# Edit dev secrets, then regenerate the derived dev env files
dev-refresh:
    just secrets edit dev
    just dev-env-generate

# Start (creating on first use) the repo's canonical local dev PostgreSQL container
dev-db-start:
    bun standards dev-db start

# Stop the repo's canonical local dev PostgreSQL container
dev-db-stop:
    bun standards dev-db stop

# Show the state of the repo's canonical local dev PostgreSQL container
dev-db-status:
    bun standards dev-db status
