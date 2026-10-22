---
name: secrets-and-config
description: Use when changing application configuration, environment variables, SOPS secret files, or generated development environments. Keeps each value in one documented owner.
---

# Secrets and configuration

A value is secret when disclosing it enables impersonation, data access, or cost. Secrets live only in SOPS-encrypted YAML. Every other value lives in plain configuration beside the code that reads it, where changes stay reviewable and reading it needs no key.

Document each value once, where it is declared. A plain value is explained in its configuration file. A secret is explained in the matching `*.example.yaml`, which mirrors the key shape of the encrypted file, because the encrypted file cannot carry readable comments. Say what the value is for and whether it is required, plus any default or behavior that its consumer does not make obvious. Use a workspace README only for setup that these declarations cannot express.

SOPS identities, recipients, CI secrets, and brokered provider credentials are covered in the declarative-infra skill's [secrets reference](../declarative-infra/references/secrets.md).

## Development environments

Each workspace's `.env.local` is generated from three layers, keyed by workspace (`apps.<name>`, `packages.<name>`):

| Layer | File | Notes |
| --- | --- | --- |
| Plain | `config/dev.yaml` | Tracked |
| Secret | `secrets/dev.yaml` | Tracked and encrypted; values are strings |
| Local | `config/dev.local.yaml` | Gitignored; overrides both tracked layers, including secret values |

A key lives in at most one of the two tracked layers. Generate with `just dev-env-generate` (`bun standards dev-env`), or run `just dev-refresh` to edit the dev secrets and then regenerate. Don't edit `.env.local` by hand: the next generation rewrites the whole file, so local changes belong in `config/dev.local.yaml`.

A plain layer can reference one half of a broker-owned S3 credential pair instead of copying it, so the value never goes stale after the broker rotates it: `{ brokeredS3: <target>, key: <dotted.key>, part: access_key_id | secret_access_key }`. The target must contain both halves. The reference resolves only when encrypted `secrets/dev.yaml` authorizes that pair in its reserved top-level `brokeredReferences` list as `<target>:<dotted.key>`. Plain configuration can select a pair, but only the encrypted policy can authorize writing it into a plaintext `.env.local`, so every such disclosure is an explicit, encrypted decision.
