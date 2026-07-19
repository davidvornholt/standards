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

# Open a secrets target (dev, ci, or an infra host name) in the SOPS editor
edit target: (_sops target)

# Rewrap a secrets target for the current recipients
updatekeys target: (_sops target "updatekeys")

# Rewrap every existing secrets target for the current recipients
updatekeys-all:
    @status=0; \
    for file in secrets/*.yaml infra/hosts/*/secrets.yaml; do \
      case "$file" in *.example.yaml) continue ;; esac; \
      [ -f "$file" ] || continue; \
      if ! just secrets _sops-file "$file" updatekeys; then status=1; fi; \
    done; \
    exit "$status"

# Resolve a target name to its secrets file and run sops against it. A target
# is `infra/hosts/<target>/secrets.yaml` when that host directory exists and
# `secrets/<target>.yaml` otherwise; unresolved names still map to
# secrets/<target>.yaml so sops can create new targets from the repo-owned
# .sops.yaml creation rules. Target names start with an ASCII letter or digit
# and otherwise contain only letters, digits, dots, underscores, or hyphens.
_sops target mode="":
    @target={{ quote(target) }}; mode={{ quote(mode) }}; \
    case "$target" in \
      ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) \
        printf 'Invalid secrets target: expected one safe path segment\n' >&2; \
        exit 1; \
        ;; \
    esac; \
    case "$mode" in \
      ''|updatekeys) ;; \
      *) printf 'Invalid SOPS mode\n' >&2; exit 1 ;; \
    esac; \
    if [ -d "infra/hosts/$target" ]; then \
      just secrets _sops-file "infra/hosts/$target/secrets.yaml" "$mode"; \
    else \
      just secrets _sops-file "secrets/$target.yaml" "$mode"; \
    fi

# Run sops (or the nix-provided sops) against a secrets file
_sops-file file mode="":
    @file={{ quote(file) }}; mode={{ quote(mode) }}; \
    if command -v sops >/dev/null 2>&1; then \
      if [ -n "$mode" ]; then sops "$mode" "$file"; else sops "$file"; fi; \
    else \
      if [ -n "$mode" ]; then \
        nix --extra-experimental-features 'nix-command flakes' run nixpkgs#sops -- "$mode" "$file"; \
      else \
        nix --extra-experimental-features 'nix-command flakes' run nixpkgs#sops -- "$file"; \
      fi; \
    fi
