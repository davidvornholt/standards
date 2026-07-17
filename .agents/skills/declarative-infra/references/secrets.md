# Secrets bootstrap (SOPS + age)

Standalone setup for a repo that needs encrypted secrets — CI tokens, app credentials — with or without host infrastructure. Host-side wiring (host-key recipients, sops-nix) is in `bootstrap.md`.

## Identities and recipients

- Personal identities are standalone age keys at `~/.config/sops/age/keys.txt`, one per person and machine. Create with `just secrets age-create`; never overwrite an existing key.
- Automation recipients (CI, PR preview) are purpose-specific keypairs, one per repo — a leaked runner key must not unlock other repos. The private key lives only in the consumer's secret store (for GitHub Actions: the `SOPS_AGE_KEY` secret). Losing one is recoverable: personal identities re-encrypt to a replacement via `updatekeys`.
- `.sops.yaml` lists recipients as named anchors, each with a comment stating what it is. Every creation rule includes all personal identities; automation recipients go only on the files that automation reads:

```yaml
keys:
  # Standalone age identity at ~/.config/sops/age/keys.txt.
  - &owner_machine age1...
  # GitHub Actions CI recipient (private key: SOPS_AGE_KEY Actions secret).
  - &github_actions_ci age1...
creation_rules:
  - path_regex: secrets/dev\.yaml$
    key_groups:
      - age:
          - *owner_machine
  - path_regex: secrets/ci\.yaml$
    key_groups:
      - age:
          - *owner_machine
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

`just secrets edit <target>` opens a target in the SOPS editor; `just secrets updatekeys <target>` rewraps it after recipient changes; `updatekeys-all` rewraps every existing target. The repo-owned `secrets.just` module (adjust the target map per repo):

```just
# Create an age key for SOPS (if missing) and print its recipient public key
age-create key_file="${HOME}/.config/sops/age/keys.txt":
    @if [ -f "{{key_file}}" ] && grep -q '^AGE-SECRET-KEY-' "{{key_file}}"; then \
      printf 'Existing age key: %s\n' "{{key_file}}"; \
    elif [ -e "{{key_file}}" ]; then \
      printf 'Refusing to overwrite existing non-age key file: %s\n' "{{key_file}}" >&2; \
      exit 1; \
    else \
      mkdir -p "$(dirname "{{key_file}}")"; \
      umask 077; \
      if command -v age-keygen >/dev/null 2>&1; then \
        output="$(age-keygen -o "{{key_file}}" 2>&1)" || { printf '%s\n' "$output" >&2; exit 1; }; \
      else \
        output="$(nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#age -c age-keygen -o "{{key_file}}" 2>&1)" || { printf '%s\n' "$output" >&2; exit 1; }; \
      fi; \
    fi; \
    just secrets age-recipient "{{key_file}}"

# Print the SOPS recipient public key for an age key file
age-recipient key_file="${HOME}/.config/sops/age/keys.txt":
    @if [ ! -f "{{key_file}}" ]; then \
      printf 'No age key file found at %s\n' "{{key_file}}" >&2; \
      exit 1; \
    fi; \
    if grep -m1 '^# public key: age1' "{{key_file}}" >/dev/null; then \
      grep -m1 '^# public key: age1' "{{key_file}}" | sed 's/^# public key: //'; \
    elif command -v age-keygen >/dev/null 2>&1; then \
      age-keygen -y "{{key_file}}"; \
    else \
      nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#age -c age-keygen -y "{{key_file}}"; \
    fi

# Open a secrets target (dev|ci) in the SOPS editor
edit target: (_sops target)

# Rewrap a secrets target (dev|ci) for the current recipients
updatekeys target: (_sops target "updatekeys")

# Rewrap every existing secrets target for the current recipients
updatekeys-all:
    @for target in dev ci; do \
      if [ -f "secrets/$target.yaml" ]; then \
        just secrets updatekeys "$target"; \
      fi; \
    done

# Run sops (or the nix-provided sops) against a target's file
_sops target *args:
    @case "{{target}}" in \
      dev) file='secrets/dev.yaml' ;; \
      ci) file='secrets/ci.yaml' ;; \
      *) printf 'Unknown secrets target: %s\n' "{{target}}" >&2; exit 1 ;; \
    esac; \
    if command -v sops >/dev/null 2>&1; then \
      sops {{args}} "$file"; \
    else \
      nix --extra-experimental-features 'nix-command flakes' run nixpkgs#sops -- {{args}} "$file"; \
    fi
```

Wire it from the root `justfile` with `mod secrets 'secrets.just'`.

## GitHub Actions wiring

- One bootstrap Actions secret per repo: `SOPS_AGE_KEY`, the CI recipient's private key (`gh secret set SOPS_AGE_KEY`).
- Workflows decrypt at runtime with a version- and checksum-pinned sops, and mask every decrypted value with `::add-mask::` — SOPS output gets no automatic log masking.
- Plane separation: secrets that bootstrap the machinery (`SOPS_AGE_KEY`, sync PATs) stay native Actions secrets; work-plane secrets live in SOPS targets.

## Rotation

Values rotate by editing the encrypted file; recipients rotate in `.sops.yaml` followed by `updatekeys`. Both land as reviewed commits.
