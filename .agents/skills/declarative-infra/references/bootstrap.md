# Bootstrapping a host repo

How to stand up the home for genuinely new infrastructure: a dedicated repo, or an `infra/` directory inside an app repo. Bootstrap only when the host or zone has no home yet — connecting an app to an existing server is an app module and image digest in that host's home repo, not a new stack. Inspect any existing infrastructure first and preserve working host definitions, state, secrets, and workflows.

Reuse is copying: instantiate this reference material inline and adapt it to the host. Do not create or depend on shared infrastructure flakes or modules across repos — improvements to the patterns belong upstream in this skill.

A dedicated infra repo is a full standards consumer like any other repo: bootstrap it with `standards init` before laying out the infrastructure, which brings the SOPS secrets workflow, the quality and drift gates, GitHub settings enforcement, Dependabot composition, and the review skills. There is no partial consumer profile — the synced TypeScript payload is deliberately carried inert rather than forking the contract per repo class. Nix and OpenTofu update blocks go in `.github/dependabot.local.yml`.

## Layout

```
infra/
  flake.nix
  flake.lock
  treefmt.nix
  modules/
    base.nix            # server profile baseline
    apps/               # host-specific services, <repo>.apps.* options
  hosts/<name>/
    configuration.nix   # composition + profile parameters; no app logic
    hardware-configuration.nix
    disko.nix
    secrets.yaml        # SOPS-encrypted
  opentofu/<stack>/     # root stacks
.sops.yaml
```

Host directories are named `<env>-<index>` (`prod-1`), even when the repo has a single server — never after the repo or product, which distinguishes nothing inside its own repo and is ambiguous in a dedicated infra repo. The index makes host replacement routine: build `prod-2` alongside, migrate, retire `prod-1`, with no mid-migration rename. The name is an identifier that must line up across `nixosConfigurations.<name>`, `deploy.nodes.<name>`, and `hosts/<name>/`, and it doubles as the `just secrets` target for the host's `secrets.yaml`, so it must be a safe path segment (an ASCII letter or digit first; only letters, digits, dots, underscores, hyphens).

The machine carries the same identifier: `networking.hostName = "prod-1"`, with `networking.domain` set to the primary domain the host serves, a DNS record `prod-1.<domain>` pointing at the machine (managed in the tofu stack like any other record), and `deploy.nodes.<name>.hostname` set to that same `prod-1.<domain>`. Do not introduce a stable machine alias such as `server.<domain>`: the durable names are the product domains themselves, which repoint at cutover, while every per-machine name is created and retired with the machine — so during a migration the two live hosts stay unambiguous in shell prompts, logs, and SSH targets.

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
      webImage = builtins.getEnv "WEB_IMAGE"; # empty only for non-deploy evaluation
    in {
      nixosConfigurations.prod-1 = lib.nixosSystem {
        inherit system;
        specialArgs = { inherit webImage; };
        modules = [
          disko.nixosModules.disko
          sops-nix.nixosModules.sops
          ./modules/base.nix
          ./modules/apps
          ./hosts/prod-1/configuration.nix
        ];
      };

      deploy.nodes.prod-1 = {
        hostname = "prod-1.example.com";
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

Build-time parameters (image digests, preview lists) enter via `specialArgs` from environment variables in the deploy workflow. Name the full-reference variable once per app (`WEB_IMAGE` above), let non-deploy evaluation use an empty fallback, and make the exact-main-SHA deploy gate reject an empty or non-`^ghcr\.io/...@sha256:[0-9a-f]{64}$` value before mutation. The workflow derives `WEB_IMAGE` only as `imageRepository@digest` from its gated checkout's enriched `images.json`; app modules consume the `webImage` argument and do not parse another manifest or define a fallback production digest. Cross-repo bumps and readback follow `image-promotion.md`.

## Server profile

Every new host takes the full profile; divergence is a documented decision in the host repo. `modules/base.nix` is its canonical statement — the parameter values are working defaults, not sacred:

```nix
{ config, lib, pkgs, ... }:
let
  adminUser = "david";
  adminSshKeys = [ "ssh-ed25519 ..." ];
  deploySshKeys = [ "ssh-ed25519 ..." ]; # CI deploy keys, root-only
  acmeEmail = "acme-contact@example.com";
in {
  nix.settings = {
    experimental-features = [ "nix-command" "flakes" ];
    trusted-users = [ "root" adminUser ];
  };
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 14d";
  };

  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;

  users.users.${adminUser} = {
    isNormalUser = true;
    extraGroups = [ "wheel" "podman" ];
    openssh.authorizedKeys.keys = adminSshKeys;
  };
  users.users.root.openssh.authorizedKeys.keys = deploySshKeys;
  security.sudo.wheelNeedsPassword = false;

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "prohibit-password";
      KbdInteractiveAuthentication = false;
    };
  };
  services.fail2ban.enable = true;

  networking.firewall = {
    enable = true;
    allowedTCPPorts = [ 22 80 443 ];
  };

  services.journald.extraConfig = ''
    SystemMaxUse=1G
    MaxRetentionSec=14day
  '';

  services.caddy = {
    enable = true;
    email = acmeEmail; # required: ACME registration contact
  };

  virtualisation.podman = {
    enable = true;
    defaultNetwork.settings.dns_enabled = true; # containers resolve each other by name
  };
  virtualisation.oci-containers.backend = "podman";

  environment.systemPackages = with pkgs; [
    curl dig gitMinimal htop jq lsof rsync vim
  ];
}
```

Beyond the module:

- Only Caddy publishes services; nothing else opens 80/443, and every additional firewall port is a documented decision in the host repo.
- Pin container images by digest.
- A host running PostgreSQL also runs a local dump timer with retention (hourly `pg_dump --format=custom` into a `postgres`-owned directory is the norm); shape the unit however reads best.
- A host running GitHub Actions jobs uses `services.github-runners.<name>` with a SOPS-provided token, `programs.nix-ld.enable = true` plus `NIX_LD`/`NIX_LD_LIBRARY_PATH` in the runner environment so downloaded tooling executes, and systemd resource caps (`CPUQuota`, `MemoryHigh`/`MemoryMax`) so jobs cannot starve the host's services.

### PostgreSQL (peer auth per app)

Host-managed and local-only. Each app database's role is owned by the database of the same name; listed system users may peer-authenticate as it over the socket. Loopback TCP gets scram; sockets never get passwords. The ident map wiring is fiddly — start from this:

```nix
{ config, lib, ... }:
let
  appDatabases = [ "my_app" ]; # database name == role name
  appSystemUsers = [ "my-app" "david" ]; # may peer-auth as any app role
  databaseSystemUsers = { }; # per-DB override, e.g. { app_pr_47 = [ "app-pr-47" ]; }
  databases = lib.unique (appDatabases ++ lib.attrNames databaseSystemUsers);
  usersFor = db: databaseSystemUsers.${db} or appSystemUsers;
in {
  services.postgresql = {
    enable = true;
    ensureDatabases = databases;
    ensureUsers = map (name: {
      inherit name;
      ensureDBOwnership = true;
    }) databases;
    authentication = lib.mkForce ''
      local all postgres peer
      ${lib.concatMapStringsSep "\n"
      (name: "local ${name} ${name} peer map=${name}") databases}
      local all all peer
      host all all 127.0.0.1/32 scram-sha-256
      host all all ::1/128 scram-sha-256
    '';
    identMap = lib.concatMapStringsSep "\n" (db:
      lib.concatMapStringsSep "\n" (user: "${db} ${user} ${db}")
      (usersFor db)) databases;
  };
}
```

## Host essentials

In `hosts/<name>/configuration.nix`: `networking.hostName` (the host identifier, per the naming rule above) and `networking.domain` (the primary domain the host serves), `time.timeZone`, profile parameters (SSH keys, ACME email, databases), app options, SOPS wiring — and `system.stateVersion`, set once at install and never changed afterward.

## App modules

Host-specific services (containers, jobs) live under the repo's own option namespace (`<repo>.apps.*`) in `modules/apps/`, gated behind `enable` options. They consume the profile: publish through Caddy virtual hosts, run on Podman with digest-pinned images, peer-auth to their database as their own system user, read secrets from SOPS paths.

A host serving a web app also carries PR preview environments as a default part of adoption — wire them alongside the app module per `pr-previews.md`.

## Secrets (SOPS + age)

Identities, recipients, `.sops.yaml` authoring, the `secrets.just` module, and CI wiring — read `secrets.md`. Host-specific on top of that:

- The host key is a recipient: derive it with `ssh-to-age < /etc/ssh/ssh_host_ed25519_key.pub` and list it (plus admin and CI keys) in `.sops.yaml` creation rules.
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

## OpenTofu root stacks

- One directory per stack under `opentofu/<stack>/`, one state per directory. Commit `.terraform.lock.hcl`. Resources are written inline; there are no shared child modules.
- Backend `backend "s3" {}` with configuration and credentials injected by the workflow/environment (R2 is S3-compatible), never hardcoded. Providers configured empty (`provider "cloudflare" {}`); credentials come from the environment.
- Non-secret identifiers (zone IDs, account IDs, record contents) are plain `locals` — they are not secrets, and inline values keep plans reviewable.
- Collections (DNS records, buckets) are one `for_each` resource over a map keyed by a stable identifier, so renaming a key is a `moved` block, not a destroy/create. DNS defaults: `ttl = 1` (auto), `proxied = false`. Buckets and other data-bearing resources carry `lifecycle { prevent_destroy = true }`.

```hcl
terraform {
  required_version = ">= 1.10.0"

  backend "s3" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {}
```

## Nix binary cache

A repo whose trusted CI builds and deploys NixOS system closures uses a private, signed binary cache. Cloudflare R2 is the default when the repo already has a Cloudflare stack; another backend works if it holds the same trust and access boundaries.

- The bucket is declared in the host's infrastructure home like any other data-bearing resource, and exists before any workflow references it.
- Validation holds a bucket-scoped read/write credential and the signing key; deployment holds a read-only credential and neither. Only the signing key's public half appears in workflow configuration.
- Validation substitutes from the cache, runs the full Nix gate, then signs and copies the closure of every check output. A failed or partial copy fails the validation job, which blocks deployment.
- Deployment waits for validation of the exact main-branch commit and substitutes that closure instead of rebuilding.
- The bucket must never be publicly readable — for R2, no `r2.dev` hostname and no custom domain. Verify through the provider API in PR validation and again before deployment.
- Document the credentials, signing-key rotation, and retention policy with the repo's other infrastructure configuration.

## Deploy downtime

A deploy that changes an app's image restarts `podman-<app>.service` in place: the old container stops before the new one starts, and Caddy has no upstream for that app until the new container is up. That brief interruption is the accepted default for this profile. The health readback in `image-promotion.md` verifies that the deploy completed; it does not keep the old container serving through the switch.

Keep the window to container startup, not registry pull: after the deploy job's identity and registry-access checks and immediately before `nix run .#deploy-rs`, the workflow pre-pulls every gated image reference on the target over the deploy SSH connection. Set `REGISTRY_AUTH_FILE` and pass `--authfile` on every Podman registry command. Public entries use the root-owned empty `/run/containers/auth/anonymous.json`; private entries use only `/run/containers/auth/ghcr-private.json`, atomically created by the host's SOPS-backed `podman-ghcr-login` unit. Give every container unit the matching `REGISTRY_AUTH_FILE` too, so implicit pulls cannot fall back to ambient Podman or Docker auth. A private pre-pull always contacts the registry even when the digest is cached, so missing or expired credentials fail before activation; a public cached digest may skip its network pull after the drift detector has independently proved anonymous access. Pulling by digest is idempotent and additive, and any failed pre-pull fails the deploy before activation touches the running system.

Private-image migration and container units require and order after `podman-ghcr-login.service`. Public-image units must not depend on that service. The SOPS secret restarts the oneshot when its decrypted value changes. The unit reads `registry.github_token` through stdin, writes a same-directory `0600` temporary auth file, and atomically renames it to the private path only after `podman login` succeeds. The complete credential, two-stage adoption, auth-file, and rotation contract is in `image-promotion.md#private-ghcr-host-access`.

Zero-downtime switchover — a second container instance behind a Caddy upstream flip, with draining — is not part of the profile. A host whose availability requirement justifies that complexity documents the decision and its wiring in the host repo, and that requirement is often the signal the app has outgrown the single-host profile.

## Install and convergence

- **First install**: nixos-anywhere with the disko layout, or a NixOS installer + `disko` run; capture `hardware-configuration.nix` from the target. After install, collect the host key and re-encrypt secrets for it.
- **Convergence**: a main-branch workflow deploys — `nix run .#deploy-rs` (deploy-rs handles rollback on failed activation) using a dedicated deploy SSH key that only CI holds; `tofu apply` runs there too, gated on the plan job. PR workflows run the validation gates only, with read-only credentials or `-backend=false`.
- Branch protection itself comes with the synced GitHub settings; what bootstrap adds is requiring the infra PR gates as status checks via the `.github/settings.local.json` seam.
