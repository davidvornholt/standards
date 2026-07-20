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

The root `justfile` and the `secrets.just` module are canonical synced files — consumers receive and update them via `bun standards sync`, and local edits are drift. `just secrets edit <target>` opens a target in the SOPS editor; `just secrets updatekeys <target>` rewraps it after recipient changes; `just secrets updatekeys-all` rewraps every existing target. A target name resolves to `infra/hosts/<target>/secrets.yaml` when that host directory exists (`prod-1`; naming convention in `bootstrap.md`) and to `secrets/<target>.yaml` otherwise (`dev`, `ci`, `pr-preview`, …), so no per-repo target map exists. Repo-specific recipes and modules (infra workflows, deploy helpers) live in a repo-owned `local.just`, which the canonical justfile imports when present.

## Derived dev env files

`secrets/dev.yaml` is keyed by workspace group and workspace (`apps.<name>`, `packages.<name>`), each mapping env keys to string values — the shape mirrored in `secrets/dev.example.yaml`. `just dev-env-generate` (the canonical recipe for `bun standards dev-env`) decrypts it and writes each declared workspace's `<group>/<name>/.env.local` with owner-only permissions and a do-not-edit header; `just dev-refresh` edits dev secrets and regenerates in one step. The command gathers all problems before writing anything: it fails when a declared workspace has no `package.json` and refuses to write any `.env.local` that git would not ignore.

## GitHub Actions wiring

- One bootstrap Actions secret per repo: `SOPS_AGE_KEY`, the CI recipient's private key (`gh secret set SOPS_AGE_KEY`).
- Workflows decrypt at runtime with a version- and checksum-pinned sops, and mask every decrypted value with `::add-mask::` — SOPS output gets no automatic log masking.
- Plane separation: only `SOPS_AGE_KEY` bootstraps the machinery and stays a native Actions secret; every other CI secret, including workflow PATs like `ci.standards_sync_token` (repository-scoped with Contents read + Pull requests write), lives in SOPS targets and is decrypted at runtime.

## Rotation

Values rotate by editing the encrypted file; recipients rotate in `.sops.yaml` followed by `updatekeys`. Both land as reviewed commits.
