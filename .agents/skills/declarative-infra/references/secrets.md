# Secrets bootstrap (SOPS + age)

This applies to every repo with encrypted secrets, with or without hosts. Host recipients and sops-nix wiring are in [bootstrap.md](bootstrap.md). Which values are secret, where each is documented, and the development environment layers are in the [secrets-and-config skill](../../secrets-and-config/SKILL.md).

## Identities and recipients

- A personal identity is a standalone age key at `~/.config/sops/age/keys.txt`, one per person and machine. Create it with `just secrets age-create`.
- Each automation recipient (CI, PR preview) is a keypair for one purpose in one repo, so a leaked runner key unlocks no other repo. Its private key lives only in the consumer's secret store, which for GitHub Actions is the `SOPS_AGE_KEY` secret. Losing one is recoverable, because the personal identities can re-encrypt the files to a replacement with `updatekeys`.
- In `.sops.yaml`, give each recipient a named anchor and a comment saying what it is. The anchor alone must identify the key: person and machine for a personal identity, purpose for automation. Use a hostname verbatim when it already names the owner (`&dana-fw13-nixos`); otherwise prefix the person (`&alice-work-laptop`).
- Every creation rule includes all personal identities. Automation recipients go only on the files that automation reads.

Create an automation keypair in a temporary directory, because `age-keygen` refuses to overwrite a file. Store the private key only in the secret store and keep only the recipient:

```sh
d=$(mktemp -d)
just secrets age-create "$d/key"    # prints the recipient for .sops.yaml
grep AGE-SECRET-KEY "$d/key" | gh secret set SOPS_AGE_KEY
rm -rf "$d"
```

## Secrets files

The root `justfile` and `secrets.just` are synced, so editing them in a consumer is drift; repo-specific recipes go in `local.just`. `secrets.just` documents its recipes and how it resolves targets. A target name binds `infra/hosts/<target>/secrets.yaml` or `secrets/<target>.yaml`, and there is no per-repo target map.

## GitHub Actions

- `SOPS_AGE_KEY` is the repo's only native Actions secret. Every other CI secret lives in SOPS targets and is decrypted at runtime.
- Decrypt with the synced [`sops-secret` action](../../../../.github/actions/sops-secret/action.yml), which pins and checksums sops and masks values. Any other decryption must use a version- and checksum-pinned sops and mask every value with `::add-mask::`, because SOPS output gets no automatic masking.
- The weekly Standards sync reads `ci.broker_app`, provisioned with `bun standards creds add github --dest ci:ci.broker_app`, and mints two current-repository tokens: a branch writer with Contents write and Workflows write, and a PR writer with Contents read and Pull requests write. There is no durable sync token or workflow-token fallback; see [automatic sync](../../standards-sync/references/github.md).
- The Standards gate's settings check holds no credential and reads with the workflow token. Do not add one: a probe showed that an installation token sees the same state.

## Brokered provider credentials

Cloudflare API tokens and cross-repo GitHub credentials come from `bun standards creds`, which writes values straight into SOPS targets and never prints them. Its help and error messages cover the scoping flags. Do not hand-create a dashboard credential for a need the broker covers.

### Minting

An R2 S3 pair (`--s3`) is used against `https://<account_id>.r2.cloudflarestorage.com`, or `https://<account_id>.eu.r2.cloudflarestorage.com` for the EU jurisdiction.

### GitHub App ceiling

- Create one private broker App per owning user or organization, installed only on selected repositories that account owns, with exactly Contents write, Metadata read, Pull requests write, and Workflows write. Workflows write is needed because the canonical payload owns `.github/workflows/**`, which Contents write cannot push.
- A workflow's `permission-*` inputs only narrow a mint. The App's permissions are the real reach of the private key in every consumer's `secrets/ci.yaml`.
- To widen the ceiling, change `creds-login-github-manifest.ts` and also toggle the permission on the existing App's settings page, because the manifest is read only when an App is created. Added permissions stay unavailable until every installation owner approves them.
- A need that only one owner's project-specific workflows have is a toggle on that owner's App alone, recorded in the repository whose workflows use it.

### Reconciliation

- To retire a brokered token, delete its SOPS key (both derived keys for an S3 pair) and run `creds apply`.
- `apply` also renews expiring tokens and regenerates dev env files that reference a renewed pair, as does every `creds add` of such a pair. A regeneration failure fails the command but does not roll back the SOPS write.
- Findings stop reconciliation before any change. A token the broker did not mint whose name claims this repository's `standards/` namespace stops it repository-wide until you rename the token in the dashboard or revoke it with the printed command.
- The unmanaged-token and other-repository reports never block. The unmanaged report is an account-wide inventory, so unrelated tokens repeat in every repository and run, and a nonempty report is not a failure. Still assess unfamiliar entries. A hand-made credential you replaced stays live until you run the `revoke` command its row prints.

### Revoking

`creds revoke` deletes one Cloudflare token by ID, and its refusals print the remedy. Use it only for tokens that reconciliation does not retire:

- For same-name duplicates left by an interrupted renewal, keep the stored key and revoke each unused duplicate ID. `revoke` refuses the stored one.
- For a token brokered to a repository that was renamed, transferred, or deleted, use `--force`, because nothing reconciles that token any more.

Each machine creates its own `standards-broker` bootstrap token. Cloudflare allows duplicate names, and login requires this name (case-insensitive). Never reuse, roll, rename, or revoke another machine's `standards-broker` token, because renaming one removes its name-based protection. Retire a superseded bootstrap token in the Cloudflare dashboard after confirming whose it is. Nothing overrides `revoke`'s refusal of bootstrap tokens.

## Rotation

- Rotate application values by editing the encrypted file. Rotate recipients by editing `.sops.yaml` and running `updatekeys`. Both land as reviewed commits.
- Brokered Cloudflare credentials renew through `creds apply`.
- A host's private-GHCR `registry.github_token` rotates by hand, through the sequence in [Private registry access](bootstrap.md#private-registry-access). The broker and `creds apply` do not manage it.

GitHub App keys also rotate by hand, in this order:

1. Create a replacement private key on the App's settings page.
2. Atomically replace `private_key` in the `github` entry for that `owner` in the broker store (the path login prints, normally `~/.config/standards/broker.yaml`), keeping mode `0600`. Updating the store first keeps later `creds add github` runs from restoring the revoked key.
3. Update every intended SOPS destination for that owner.
4. Verify that workflows can mint installation tokens.
5. Revoke the old key.
