# @davidvornholt/standards

CLI for initializing, synchronizing, and validating repositories that consume [`davidvornholt/standards`](../../README.md).

## Install

Start a new repository without a prior installation:

```sh
bunx @davidvornholt/standards init
bun install
bun run check
```

Adopt an existing repository by installing the exact package first:

```sh
bun add --dev --exact @davidvornholt/standards
bun standards init
```

Read the [adoption guide](../../docs/adoption.md) before running `init` in a repository that already has agent instructions, Just recipes, Dependabot configuration, or Claude skills.

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Seed project-owned files, mirror canonical paths, generate owned output, and create the lock. |
| `sync` | Mirror the selected upstream revision and update the lock. |
| `check` | Verify drift, extension points, structure, generated output, and GitHub settings. |
| `doctor` | Validate integration points without checking lock-backed drift. |
| `structure` | Validate the monorepo contract. |
| `dependabot` | Verify or regenerate `.github/dependabot.yml`. |
| `dev-env` | Generate workspace `.env.local` files. |
| `github` | Compare or converge live repository settings. |
| `creds` | Mint and reconcile brokered credentials. |
| `screenshots` | Publish pull-request screenshots through the configured bucket. |
| `poller` | Run one approved fix or review automation tick. |
| `help` | Print command and option help. |

Use `bun standards help`, `bun standards creds help`, or `bun standards screenshots help` for the complete invocation syntax.

## init

```sh
bun standards init [--dir <repo>] [--from <source>] [--ref <ref>]
```

`init` is a one-time ownership cutover. It:

1. seeds missing project-owned files from `template/`;
2. mirrors every canonical path in `sync-standards.json`;
3. regenerates engine-owned output;
4. writes `sync-standards.lock`.

Existing project-owned files are kept. Synced files are replaced. `init` refuses after a lock exists and refuses before writing when a managed destination is a directory containing unowned work.

## sync

```sh
bun standards sync --dry-run
bun standards sync
bun standards sync --ref v0.26.0
bun standards sync --from ../standards
```

`sync` mirrors canonical files and symlinks, removes canonical paths deleted upstream, regenerates `.github/dependabot.yml`, and rewrites the lock.

`--dry-run` prints the full plan without writing. `--ref` selects a tag, branch, or full commit SHA for a remote source. `--from` accepts another GitHub source or a local checkout.

A local source is useful for testing unpublished canonical changes, but its lock may describe content that does not exist upstream. Discard that test state afterward. See [Sync and ownership](../../docs/sync-and-ownership.md#test-an-unpublished-canonical-change).

## check

```sh
bun standards check
```

The command fails when:

- a lock-backed canonical path changed, disappeared, or has the wrong path type;
- a required extension point is missing or invalid;
- generated Dependabot output differs from its inputs;
- the monorepo structure contract fails;
- the CI secret files have an invalid encrypted or example shape;
- declared GitHub settings differ from live state or cannot be verified.

The canonical workflow performs the live GitHub comparison in its restricted aggregator job. Local checks use the available `gh`, `GH_TOKEN`, or `GITHUB_TOKEN` authentication.

## doctor and structure

```sh
bun standards doctor
bun standards structure
bun standards structure --profile source
```

`doctor` checks project-owned integration points such as `biome.jsonc`, `AGENTS.local.md`, package scripts, sync policy, settings overlays, and Dependabot inputs.

`structure` checks workspace scripts, internal dependency versions, package exports, TypeScript inheritance, accessibility wiring, workspace READMEs, and CI secret structure. The `source` profile records the few intentional differences in this repository itself.

## dependabot

```sh
bun standards dependabot --check
bun standards dependabot --write
```

The generated `.github/dependabot.yml` combines:

- canonical `.github/dependabot.base.yml`;
- project-owned `.github/dependabot.local.yml`.

The local overlay may add update blocks, private registries, and `ignore` or `registries` entries on matching canonical targets. It cannot replace canonical policy.

## dev-env

```sh
bun standards dev-env
just dev-env-generate
```

Each workspace environment is composed in this order:

1. `config/dev.yaml`, tracked configuration;
2. `secrets/dev.yaml`, SOPS-encrypted shared secrets and reference policy;
3. `config/dev.local.yaml`, gitignored machine-specific overrides.

Later layers win, but one key cannot exist in both tracked layers. The command validates every destination before writing and commits all generated-file changes as one transaction.

A plain layer may reference one part of a broker-owned S3 pair:

```yaml
apps:
  web:
    R2_ACCESS_KEY_ID:
      brokeredS3: assets
      key: assets.web
      part: access_key_id
```

Authorize the complete pair in encrypted `secrets/dev.yaml`:

```yaml
brokeredReferences:
  - assets:assets.web
```

The referenced target must contain both `access_key_id` and `secret_access_key`. Every generated `.env.local`, transaction artifact, and `config/dev.local.yaml` must be ignored by Git.

## github

```sh
bun standards github --check
bun standards github --apply
```

The command merges `.github/settings.json` with `.github/settings.local.json`, then compares or converges repository settings, declared rulesets, and canonical labels. Undeclared live labels are left alone. Undeclared repository-owned rulesets are removed by `--apply`.

`--apply` needs admin authentication and rechecks the API response instead of treating an accepted request as success. A repository whose plan cannot enforce rulesets may declare `"rulesetEnforcement": "unavailable-on-plan"` in the local settings file.

## creds

The broker writes secret values directly into SOPS targets. It does not print them or pass them through command arguments.

### Bootstrap providers

```sh
bun standards creds login github
bun standards creds login github --org <org>
bun standards creds login cloudflare
bun standards creds status
```

The machine-global broker store lives at `$XDG_CONFIG_HOME/standards/broker.yaml`, or `~/.config/standards/broker.yaml` by default, with owner-only permissions. It holds one private GitHub App per repository owner and one Cloudflare bootstrap token per account.

### Mint credentials

```sh
bun standards creds add github --dest ci:ci.broker_app
bun standards creds add cloudflare \
  --dest ci:ci.cloudflare_workers_token \
  --permissions "Workers Scripts Write"
bun standards creds add cloudflare \
  --dest assets:assets.screenshots_rw \
  --bucket screenshots \
  --s3 \
  --permissions "Workers R2 Storage Bucket Item Write"
```

Use `--zone <id>` for zone-scoped Cloudflare permissions and `--jurisdiction eu` for an EU R2 bucket. Run `bun standards creds permissions` to list accepted permission-group names.

### Reconcile Cloudflare tokens

```sh
bun standards creds plan
bun standards creds apply
```

The desired destinations are inferred from SOPS key structure. `plan` reports renewals, revocations, unmanaged tokens, and tokens owned by another repository. `apply` renews expiring brokered tokens and revokes brokered tokens whose SOPS destination was removed. It never changes credentials it did not mint.

To delete one Cloudflare token outside normal reconciliation:

```sh
bun standards creds revoke --account <account-id> --token-id <token-id>
```

Bootstrap credentials and tokens still owned by an active repository are refused.

## screenshots

```sh
bun standards screenshots publish docs/pr/settings-page.png docs/pr/settings-empty-state.png
```

The command reads `config/screenshots.yaml`, resolves its S3 pair from SOPS, uploads each supported image to a content-addressed key, and prints Markdown image lines in input order.

```yaml
pair: assets:assets.screenshots_rw
bucket: screenshots
endpoint: https://<account-id>.r2.cloudflarestorage.com
publicBaseUrl: https://screenshots.example.com
```

Published URLs are public and permanent. Use demo data and exclude secrets and personal data.

## poller

```sh
bun standards poller --config <path>
bun standards poller --acknowledge-only --config <path>
bun standards poller --print-units --config <path>
```

The host-level JSON configuration requires:

```json
{
  "repos": ["owner/repo"],
  "model": "<codex model>",
  "reasoningEffort": "<effort>"
}
```

Optional keys are `maxJobsPerTick`, `staleClaimHours`, `runTimeoutMinutes`, `cacheDir`, and `extraCodexArgs`. One poller supports at most 12 repositories.

The worker accepts only exact issue or draft-PR revisions approved by a user with `admin` or `maintain` role. It runs Codex in a disposable worktree, revalidates approval before publication, and leaves merge to a human. The polling host owns authenticated `codex` and `gh`, the service token, writable home, configuration, and systemd deployment.

## Configuration index

| File or variable | Purpose |
| --- | --- |
| `sync-standards.json` | Canonical source, seed directory, and managed paths. |
| `sync-standards.local.json` | Optional `ref` pin and `autoSync` policy. |
| `sync-standards.lock` | Exact synchronized commit and managed digests. |
| `.github/dependabot.local.yml` | Project-owned Dependabot additions. |
| `.github/settings.local.json` | Project-owned GitHub settings additions. |
| `config/dev.yaml` | Shared non-secret development configuration. |
| `secrets/dev.yaml` | Shared development secrets and broker-reference policy. |
| `config/dev.local.yaml` | Machine-specific overrides. |
| `config/screenshots.yaml` | Public screenshot bucket and SOPS pair reference. |
| `STANDARDS_BROKER_FILE` | Optional broker-store path override. |
| `GH_TOKEN` or `GITHUB_TOKEN` | GitHub API authentication where required. |

The [root README](../../README.md) gives the short overview. The [adoption guide](../../docs/adoption.md) and [sync guide](../../docs/sync-and-ownership.md) explain repository ownership and first use.
