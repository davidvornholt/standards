# Bootstrapping a host repo

How to stand up a new self-contained infrastructure repo (or an `infra/` directory inside an app repo). Inspect any existing infrastructure first and preserve working host definitions, state, secrets, and workflows.

## Layout

```
infra/
  flake.nix
  flake.lock
  treefmt.nix
  modules/
    base.nix            # server profile baseline (references/nixos.md)
    apps/               # host-specific services, <repo>.apps.* options
  hosts/<name>/
    configuration.nix   # composition + profile parameters; no app logic
    hardware-configuration.nix
    disko.nix
    secrets.yaml        # SOPS-encrypted
  opentofu/<stack>/     # root stacks (references/opentofu.md)
.sops.yaml
```

## Flake skeleton

```nix
{
  description = "<repo> production infrastructure";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    deploy-rs.url = "github:serokell/deploy-rs";
    deploy-rs.inputs.nixpkgs.follows = "nixpkgs";
    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";
    sops-nix.url = "github:Mic92/sops-nix";
    sops-nix.inputs.nixpkgs.follows = "nixpkgs";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs@{ self, nixpkgs, deploy-rs, disko, sops-nix, treefmt-nix, ... }:
    let
      system = "x86_64-linux";
      inherit (nixpkgs) lib;
      pkgs = nixpkgs.legacyPackages.${system};
      treefmtEval = treefmt-nix.lib.evalModule pkgs ./treefmt.nix;
    in {
      nixosConfigurations.prod-1 = lib.nixosSystem {
        inherit system;
        modules = [
          disko.nixosModules.disko
          sops-nix.nixosModules.sops
          ./modules/base.nix
          ./modules/apps
          ./hosts/prod-1/configuration.nix
        ];
      };

      deploy.nodes.prod-1 = {
        hostname = "server.example.com";
        profiles.system = {
          user = "root";
          path = deploy-rs.lib.${system}.activate.nixos
            self.nixosConfigurations.prod-1;
        };
      };

      formatter.${system} = treefmtEval.config.build.wrapper;

      checks.${system} = {
        formatting = treefmtEval.config.build.check self;
        prod-1-system = self.nixosConfigurations.prod-1.config.system.build.toplevel;
      } // deploy-rs.lib.${system}.deployChecks self.deploy;
    };
}
```

Build-time parameters (image digests, preview lists) enter via `specialArgs` from environment variables in the deploy workflow, with safe fallbacks so plain `nix flake check` evaluates without them.

## Host essentials

In `hosts/<name>/configuration.nix`: `networking.hostName`, `networking.domain`, `time.timeZone`, profile parameters (SSH keys, ACME email, databases), app options, SOPS wiring — and `system.stateVersion`, set once at install and never changed afterward.

## Secrets (SOPS + age)

- Host key is the recipient: derive with `ssh-to-age < /etc/ssh/ssh_host_ed25519_key.pub`, list it (plus admin keys) in `.sops.yaml` creation rules.
- Admin and CI recipients come from age keys: `age-keygen -o <file>` creates one, `age-keygen -y <file>` prints its public key. When the repo uses `just`, instantiate the recipes below as a repo-owned `secrets.just` module (`mod secrets 'secrets.just'` in the justfile) so key setup is one command:

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
```

- Host side:

```nix
sops = {
  age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
  defaultSopsFile = ./secrets.yaml;
  secrets."apps/web/env" = {
    mode = "0400";
    restartUnits = [ "podman-web.service" ]; # redeploy picks up rotations
  };
};
```

## Install and convergence

- **First install**: nixos-anywhere with the disko layout, or a NixOS installer + `disko` run; capture `hardware-configuration.nix` from the target. After install, collect the host key and re-encrypt secrets for it.
- **Convergence**: a main-branch workflow deploys — `nix run .#deploy-rs` (deploy-rs handles rollback on failed activation) using a dedicated deploy SSH key that only CI holds; `tofu apply` runs there too, gated on the plan job. PR workflows run the validation gates only (`nix flake check`, toplevel build, `tofu plan`) with read-only credentials or `-backend=false`.
- Protect the default branch: require the PR gates, no force-push, no bypass. The deploy workflow is the only thing that mutates infrastructure.
