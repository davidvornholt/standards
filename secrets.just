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
