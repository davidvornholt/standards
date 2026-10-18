# Secrets bootstrap (SOPS + age)

For any repo with encrypted secrets, with or without hosts. Host recipients and sops-nix wiring are in [bootstrap.md](bootstrap.md). Value ownership and the three dev env layers are in the [secrets-and-config skill](../../secrets-and-config/SKILL.md).

## Identities and recipients

- A personal identity is a standalone age key at `~/.config/sops/age/keys.txt`, one per person and machine. Create it with `just secrets age-create`; never overwrite an existing key.
- Each automation recipient (CI, PR preview) is a purpose-specific keypair for one repo, so a leaked runner key unlocks no other repo. Its private key lives only in the consumer's secret store; for GitHub Actions that is the `SOPS_AGE_KEY` secret. A lost one is recoverable: personal identities re-encrypt to a replacement with `updatekeys`.
- In `.sops.yaml`, give each recipient a named anchor and a comment saying what it is. The anchor alone must identify the key: person and machine for personal identities, purpose for automation. Use a hostname verbatim when it already names the owner (`&dana-fw13-nixos`); otherwise prefix the person (`&alice-work-laptop`).
- Every creation rule includes all personal identities. Automation recipients go only on the files that automation reads.
- Create an automation keypair in a temporary directory (`age-keygen` refuses existing files), store the private key only in the secret store, and keep only the recipient:

```sh
d=$(mktemp -d)
just secrets age-create "$d/key"    # prints the recipient for .sops.yaml
grep AGE-SECRET-KEY "$d/key" | gh secret set SOPS_AGE_KEY
rm -rf "$d"
```

## Secrets files

- The root `justfile` and `secrets.just` are synced; editing them in a consumer is drift. Repo-specific recipes go in `local.just`. `secrets.just` documents its recipes and target resolution.
- A target name binds `infra/hosts/<target>/secrets.yaml` or `secrets/<target>.yaml`. When both exist, `just secrets`, `dev-env`, and `creds` reject the name as ambiguous; rename one. There is no per-repo target map.

## Dev env files

- `config/dev.local.yaml` wins over both tracked layers and may override secret values. Secret-layer values are strings.
- A plain-layer value may reference one part of a broker-owned S3 pair as `{ brokeredS3: <target>, key: <dotted.key>, part: access_key_id | secret_access_key }`. The target must contain both parts.
- Authorize each referenced pair in encrypted `secrets/dev.yaml` under the reserved top-level `brokeredReferences` list as `<target>:<dotted.key>`. Plain configuration selects a pair; only encrypted policy authorizes writing it into `.env.local`.
- Generate with `just dev-env-generate` (`bun standards dev-env`). `just dev-refresh` edits dev secrets and regenerates.

## GitHub Actions

- `SOPS_AGE_KEY` is the repo's only native Actions secret. Every other CI secret lives in SOPS targets and is decrypted at runtime.
- Decrypt with the synced [`sops-secret` action](../../../../.github/actions/sops-secret/action.yml), which pins and checksums sops and masks values. Any other decryption must use a version- and checksum-pinned sops and mask every value with `::add-mask::`; SOPS output gets no automatic masking.
- The weekly Standards sync reads `ci.broker_app`, provisioned with `bun standards creds add github --dest ci:ci.broker_app`, and mints two current-repository tokens: a branch writer with Contents write and Workflows write, and a PR writer with Contents read and Pull requests write. There is no durable sync token or workflow-token fallback; see [automatic sync](../../standards-sync/references/github.md).
- The Standards gate's settings check holds no credential and reads with the workflow token. Do not add one: a probe showed an installation token sees the same state.

## Brokered provider credentials

Cloudflare API tokens and cross-repo GitHub credentials come from `bun standards creds` (see `bun standards creds help`), which writes values straight into SOPS targets and never prints them. Do not hand-create a dashboard credential for a need the broker covers.

### Minting

- Zone-scoped Cloudflare groups such as DNS Write need `--zone <zone-id>`, the 32-character hexadecimal ID on the zone's dashboard overview. Domain names do not work: resolving them would need Zone Read, and the bootstrap token holds only Account API Tokens / Edit.
- For R2, `--bucket <name>` scopes the token to one bucket and cannot be combined with `--zone`. `--jurisdiction` is `default` or `eu`; FedRAMP is not supported. `--s3` requires `--bucket` and stores `<dotted.key>.access_key_id` and `<dotted.key>.secret_access_key` instead of the token. The endpoint is `https://<account_id>.r2.cloudflarestorage.com`, or `https://<account_id>.eu.r2.cloudflarestorage.com` for EU.
- `creds add github --dest <target>:<dotted.key>` selects the broker App owned by the origin's owner, verifies it is installed on this exact repository, and stores its credentials so workflows mint short-lived installation tokens at runtime.

### GitHub App ceiling

- Create one private broker App per owning user or organization, installed only on selected repositories that account owns, with exactly Contents write, Metadata read, Pull requests write, and Workflows write. Workflows write is needed because the canonical payload owns `.github/workflows/**`, which Contents write cannot push.
- A workflow's `permission-*` inputs only narrow a mint. The App's permissions are the real reach of the private key in every consumer's `secrets/ci.yaml`.
- To widen the ceiling, change `creds-login-github-manifest.ts` and toggle the permission on the existing App's settings page; the manifest is read only when an App is created. Added permissions stay unavailable until every installation owner approves them.
- A need that only one owner's project-specific workflows have is a toggle on that owner's App alone, recorded in the repository whose workflows use it.

### Reconciliation

- `creds plan` and `creds apply` reconcile only Cloudflare tokens the broker minted, always across every configured account.
- To revoke a brokered token, delete its SOPS key (both derived keys for an S3 pair) and run `creds apply`.
- `apply` also renews expiring tokens and regenerates dev env files that reference a renewed pair, as does every `creds add` of such a pair. A regeneration failure fails the command but does not roll back the SOPS write.
- Findings stop reconciliation before any change. A token the broker did not mint whose name claims this repository's `standards/` namespace stops it repository-wide until you rename the token in the dashboard or revoke it with the printed command.
- The unmanaged-token and other-repository reports never block. The unmanaged report is an account-wide inventory, so unrelated tokens repeat in every repository and run, and a nonempty report is not a failure; still assess unfamiliar entries. A hand-made credential you replaced stays live until you run the `revoke` command its row prints.

### Revoking

`creds revoke --account <account-id> --token-id <id>` deletes one Cloudflare token. Its refusals print the remedy.

- Retire a token brokered to this repository by deleting its SOPS key and running `creds apply`, not with `revoke`. For same-name duplicates left by an interrupted renewal, keep the stored key and revoke each unused duplicate ID; `revoke` refuses the stored one.
- Use `--force` only for a token brokered to a repository that was renamed, transferred, or deleted, so that nothing reconciles it. It verifies nothing about that repository.
- Each machine creates its own `standards-broker` bootstrap token; Cloudflare allows duplicate names, and login requires this name (case-insensitive). Never reuse, roll, rename, or revoke another machine's `standards-broker` token; renaming one removes its name-based protection. Retire a superseded bootstrap token in the Cloudflare dashboard after confirming whose it is. Nothing overrides `revoke`'s refusal of bootstrap tokens.

## Rotation

- Rotate application values by editing the encrypted file, and recipients in `.sops.yaml` followed by `updatekeys`; both land as reviewed commits.
- Brokered Cloudflare credentials renew through `creds apply`.
- GitHub App keys rotate by hand, in this order: create a replacement private key on the App's settings page; atomically replace `private_key` in the `github` entry for that `owner` in the broker store (the path login prints, normally `~/.config/standards/broker.yaml`), keeping mode `0600`; update every intended SOPS destination for that owner; verify workflows can mint installation tokens; revoke the old key. Updating the store first keeps later `creds add github` runs from restoring the revoked key.
- A host's private-GHCR `registry.github_token` also rotates by hand, through the sequence in [Private registry access](bootstrap.md#private-registry-access). The broker and `creds apply` do not manage it.
