set dotenv-load := false

mod secrets 'secrets.just'

# Repo-specific recipes and modules extend this canonical file from a
# repo-owned local.just; this file is synced and must not be edited locally.

import? 'local.just'

default:
    @just --list

# Compose each workspace's .env.local from tracked config/dev.yaml, the SOPS-encrypted secrets/dev.yaml, and gitignored config/dev.local.yaml overrides
dev-env-generate:
    bun standards dev-env

# Edit dev secrets, then regenerate the derived dev env files
dev-refresh:
    just secrets edit dev
    just dev-env-generate
