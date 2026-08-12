# Secrets bootstrap (SOPS + age)

Standalone setup for a repo that needs encrypted secrets — CI tokens, app credentials — with or without host infrastructure. Host-side wiring (host-key recipients, sops-nix) is in `bootstrap.md`.

## Identities and recipients

- Personal identities are standalone age keys at `~/.config/sops/age/keys.txt`, one per person and machine. Create with `just secrets age-create`; never overwrite an existing key.
- Automation recipients (CI, PR preview) are purpose-specific keypairs, one per repo — a leaked runner key must not unlock other repos. The private key lives only in the consumer's secret store (for GitHub Actions: the `SOPS_AGE_KEY` secret). Losing one is recoverable: personal identities re-encrypt to a replacement via `updatekeys`.
- `.sops.yaml` lists recipients as named anchors, each with a comment stating what it is. Name each anchor so it identifies the identity on its own — the person and machine for personal identities, the purpose for automation recipients. Use the machine's hostname verbatim when it already encodes the owner (e.g. `&dana-fw13-nixos`); prefix the person only when it does not (e.g. `&alice-work-laptop`). Every creation rule includes all personal identities; automation recipients go only on the files that automation reads:

```yaml
keys:
  # Standalone age identity at ~/.config/sops/age/keys.txt.
  - &dana-fw13-nixos age1...
  # GitHub Actions CI recipient (private key: SOPS_AGE_KEY Actions secret).
  - &github_actions_ci age1...
creation_rules:
  - path_regex: secrets/dev\.yaml$
    key_groups:
      - age:
          - *dana-fw13-nixos
  - path_regex: secrets/ci\.yaml$
    key_groups:
      - age:
          - *dana-fw13-nixos
          - *github_actions_ci
```

- Creating an automation keypair: generate into a temp directory (`age-keygen` refuses existing files), store the private key only in the consumer's secret store, keep only the recipient:

```sh
d=$(mktemp -d)
just secrets age-create "$d/key"    # prints the recipient for .sops.yaml
grep AGE-SECRET-KEY "$d/key" | gh secret set SOPS_AGE_KEY
rm -rf "$d"
```

## Working with secrets files

The root `justfile` and the `secrets.just` module are canonical synced files — consumers receive and update them via `bun standards sync`, and local edits are drift. `just secrets edit <target>` opens a target in the SOPS editor; `just secrets updatekeys <target>` rewraps it after recipient changes; `just secrets updatekeys-all` rewraps every existing target. An existing target name must bind exactly one file: `infra/hosts/<target>/secrets.yaml` for a host target or `secrets/<target>.yaml` for a flat target. If neither file exists, an existing host directory selects its host secrets file and every other name selects the flat file. If both files exist, `just secrets`, `dev-env`, and credential reconciliation reject the name as ambiguous instead of preferring one, so no per-repo target map exists and no broker action can infer ownership from a shadowed file. Repo-specific recipes and modules (infra workflows, deploy helpers) live in a repo-owned `local.just`, which the canonical justfile imports when present.

## Derived dev env files

The dev environment is declared across three workspace-keyed layers (`apps.<name>`, `packages.<name>` — the shape mirrored in `secrets/dev.example.yaml`): tracked configuration in `config/dev.yaml`, literal dev secrets plus broker-reference policy in the SOPS-encrypted `secrets/dev.yaml`, and per-developer/per-machine overrides in the gitignored plain `config/dev.local.yaml`, which wins over both and may override secret values (it is exactly as untracked as the generated output it feeds). Secret-layer env values are strings. A plain-layer env value may instead reference one broker-owned S3 pair part as `{ brokeredS3: <target>, key: <dotted.key>, part: access_key_id | secret_access_key }`, making that pair's separate SOPS target an additional value source for the generated environment. Authorize every referenced pair inside encrypted `secrets/dev.yaml` under the reserved top-level `brokeredReferences` list with its exact `<target>:<dotted.key>` string. Plain layers reject that reserved key, and the secrets layer rejects reference objects: configuration selects a pair while encrypted policy authorizes declassification into `.env.local`. An unauthorized pair is rejected with the exact entry to add before its target is decrypted. Authorized target names must bind exactly one contained secrets file, are decrypted once per generation, and must contain both string S3 pair parts. A later literal override wins before reference resolution, so an overridden target is not decrypted. A key declared in both tracked layers is an error — a value is either configuration or a secret. `just dev-env-generate` (the canonical recipe for `bun standards dev-env`) decrypts the secrets layer, composes the three, resolves authorized referenced targets, and writes each declared workspace's `<group>/<name>/.env.local` with owner-only permissions and a do-not-edit header naming the contributing sources; `just dev-refresh` edits dev secrets and regenerates in one step. The command gathers all problems before writing anything: it fails when a declared workspace has no `package.json`, when `config/dev.local.yaml` exists but is not gitignored, and refuses to write any `.env.local` that git would not ignore.

## GitHub Actions wiring

- One bootstrap Actions secret per repo: `SOPS_AGE_KEY`, the CI recipient's private key (`gh secret set SOPS_AGE_KEY`).
- Workflows decrypt at runtime with a version- and checksum-pinned sops, and mask every decrypted value with `::add-mask::` — SOPS output gets no automatic log masking.
- Plane separation: only `SOPS_AGE_KEY` bootstraps the machinery and stays a native Actions secret; every other CI secret lives in SOPS targets and is decrypted at runtime. The weekly Standards sync resolves `ci.broker_app.app_id` and `ci.broker_app.private_key`, then mints two short-lived installation tokens for only the current repository: a branch writer with Contents write and Workflows write, and a PR opener with Contents read and Pull requests write. Both mint before sync as permission preconditions, but neither enters the sync process; each is exposed only to its post-sync operation. Missing App credentials, unapproved App permissions, or failed minting stop the workflow; there is no durable sync token or workflow-token fallback. The settings comparison in the Standards gate's `check` aggregator job resolves nothing and holds no durable credential: a private-repository probe compared an installation token against a token holding exactly that job's `contents: read` and `issues: read` grants across every read the check performs and found no difference, so the job reads with the workflow token and still fails closed on state that token cannot see.

## Brokered provider credentials

Cloudflare API tokens and cross-repo GitHub credentials come from the credential broker, which writes values straight into SOPS targets — never into the terminal, and never hand-created in a provider dashboard for a need the broker covers.

### Minting

- `bun standards creds add cloudflare --dest <target>:<dotted.key> --permissions "<Account Group Name>"` mints a scoped, expiring account token. Permission groups must match the resource supplied: `--zone <zone-id>[,<zone-id>...]` adds a zone resource for zone-scoped groups such as DNS Write and requires at least one such group; account-only groups keep their own account policy on the same token. Zones are named by their 32-character hexadecimal ID from the zone's dashboard overview, because resolving a domain name would need Zone Read on the bootstrap token, which holds Account API Tokens / Edit and nothing else.
- R2 object storage is fully brokered: `--bucket <name>` scopes the token to one bucket (`--zone` cannot be combined with it), `--jurisdiction default|eu` selects its jurisdiction (default: `default`; FedRAMP is not supported), and `--s3` requires `--bucket` and stores the S3-compatible pair (`<dotted.key>.access_key_id`, `<dotted.key>.secret_access_key`) instead of the raw token. The default endpoint is `https://<account_id>.r2.cloudflarestorage.com`; EU inserts `.eu` before `.r2`. Example: `bun standards creds add cloudflare --dest ci:ci.r2_read --bucket assets --s3 --permissions "Workers R2 Storage Bucket Item Read"`.
- `bun standards creds add github --dest <target>:<dotted.key>` selects the private broker App whose owner matches the repository origin, verifies that App is installed on the exact repository, and places its credentials for workflows to mint short-lived installation tokens at runtime. Provision the canonical weekly sync shape with `bun standards creds add github --dest ci:ci.broker_app`.

### GitHub App ceiling

Create one private GitHub App per owning user or organization and install it only on selected repositories that account owns, with exactly Actions read, Contents write, Issues write, Metadata read, Pull requests write, and Workflows write — Workflows write because the canonical payload owns `.github/workflows/**`, which Contents write alone cannot push. A workflow's `permission-*` inputs only narrow what it mints; the App's own permissions are the real reach of the private key stored in each consumer's `secrets/ci.yaml`. A need outside that set is a deliberate change to the ceiling in `creds-login-github-manifest.ts` plus the matching toggle on the existing App's settings page — the manifest is read only at creation time, so editing it alone changes nothing for an existing App — and added permissions remain unavailable until every installation owner approves the update.

### Reconciliation (`creds plan` / `creds apply`)

Reconciliation covers Cloudflare tokens only, and only ones the broker minted. Deleting the secret key (for S3 pairs, both derived keys) from the SOPS file and applying revokes the provider-side token. An expiring token is renewed only after its stored access key ID is proven to match the current provider token, then replaced by durably writing and verifying the new pair before revoking the old token. Intersecting managed bearer/S3 destination footprints are findings and stop reconciliation before mutation, as is a token whose name claims this repository's reserved `standards/` namespace without being broker-minted — that finding aborts reconciliation repository-wide until the token is renamed in the dashboard or revoked with the command the finding prints.

Both commands also report, in two labelled blocks that never block reconciliation, what they will never renew or revoke:

- **Unmanaged tokens**: every unexpired token outside the reserved `standards/` namespace (expired tokens grant nothing and are left out; the machine's own bootstrap credential is removed by verified ID before anything is classified). Replacing a hand-made credential therefore leaves a live orphan unless it is retired — each row normally prints the exact `revoke` command that does so.
- **Tokens brokered to another repository**, each named with the repository whose `apply` owns it.

### Revoking

`bun standards creds revoke --account <account-id> --token-id <id>` deletes exactly one Cloudflare token, named by its 32-character hexadecimal token ID; `--account` is required whenever more than one Cloudflare account is configured. It takes ownership from the origin remote and compares repository names case-insensitively (as GitHub does), while `plan` classifies by exact token name — the source of the disagreement in the second refusal below. The refusals:

- **Brokered to this repository**: retire it by deleting its SOPS key and running `creds apply`, which revokes the token and keeps the secret in step.
- **Brokered name differing from this checkout's origin only in capitalisation**: `plan` files it as brokered elsewhere with a `--force` command, but `revoke` reads it as this checkout's own and refuses, and exact-name reconciliation would neither renew nor revoke it — so both the listing's label and its renamed-transferred-or-deleted explanation are wrong for this row. Re-point the origin remote at the capitalisation the token carries, or retire it in the Cloudflare dashboard.
- **Brokered to a genuinely different repository**, which is named: the same delete-key-and-`apply` remedy runs there. `--force` widens exactly this refusal and nothing else. It verifies nothing about that repository's state, so it is justified only when nothing reconciles the token any more — the owning repository was renamed, transferred, or deleted, and no checkout resolves to its name. If the origin remote resolves to no GitHub repository, every brokered token is refused, `--force` included, because the check it widens never ran.
- **Bootstrap guards, which nothing overrides**: this machine's stored bootstrap credential is refused by verified ID, and any other token named `standards-broker` is refused by name — the reserved name belongs to another machine's bootstrap or a superseded one, retired in the Cloudflare dashboard, where you can confirm whose it is. The broker cannot re-mint its own root credential.

To consume a brokered S3 pair in generated dev env files without copying it, authorize the destination's exact `<target>:<dotted.key>` entry under encrypted `secrets/dev.yaml` `brokeredReferences`, then point plain-layer env reference objects at the same target and key. Every verified `creds add` write or `creds apply` renewal of that exact referenced pair regenerates the dev env files. If one pair cannot be verified after a write while a sibling pair commits, regeneration updates the verified sibling but preserves the unsafe pair's prior generated values; it fails loudly without changing any env file when those prior generated values cannot be proven and preserved. A regeneration failure does not roll back a durable SOPS write.

## Rotation

Application-owned values rotate by editing the encrypted file; recipients rotate in `.sops.yaml` followed by `updatekeys`. Both land as reviewed commits. Brokered Cloudflare credentials renew via `bun standards creds apply`, which creates a fresh-expiry replacement, durably writes and verifies its value, regenerates dev env files when the destination is referenced, and then revokes the old token. A failed post-write regeneration is reported as a command failure without rolling back the already durable SOPS replacement.

That brokered rotation path is Cloudflare-only. GitHub App keys rotate manually: create a replacement private key on the App settings page, then atomically replace `private_key` only in the matching `github` list entry identified by its `owner` in the protected machine-global broker store (the path printed by login, normally `~/.config/standards/broker.yaml`) while preserving its `0600` mode. Only after the broker store holds the replacement should you update every intended SOPS destination for that owner, verify workflows can mint installation tokens, and revoke the old key on the settings page. This order ensures every later `bun standards creds add github` reads the replacement key rather than restoring the revoked one.

A standalone host's private-GHCR `registry.github_token` is another manual exception because GitHub provides no API for minting or rotating classic package PATs. Keep it only in the SOPS-encrypted host target with `read:packages`, account for every package its owner can read, rotate it through the replace-refresh-verify-revoke sequence in `image-promotion.md#private-ghcr-host-access`, and never claim that the broker or `creds apply` manages it.
