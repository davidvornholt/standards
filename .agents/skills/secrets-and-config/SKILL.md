---
name: secrets-and-config
description: Use when changing application configuration, environment variables, SOPS secret files, or generated development environments. Keeps each value in one documented owner.
---

# Secrets and configuration

A value is secret when disclosure enables impersonation, data access, or cost. Keep secrets only in SOPS-encrypted YAML and other values in plain configuration beside their consumer.

Explain each value once: plain values in their configuration, secrets in the matching `*.example.yaml`, which mirrors the encrypted target's key shape. State purpose and requiredness, plus any default or behavior its consumer does not make obvious. Use workspace READMEs only for setup those declarations cannot express.

Development environments have three workspace-keyed layers: tracked `config/dev.yaml`, encrypted `secrets/dev.yaml`, and gitignored `config/dev.local.yaml` overrides. A key cannot live in both tracked layers. Generate `.env.local` with `bun standards dev-env`; never edit it directly.
