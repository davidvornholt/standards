# Bootstrapping a host repo

- Bootstrap only when a host or zone has no infrastructure home. Connecting an app to an existing server is an app module plus an [app-release](app-release.md) unit in that host's home repo.
- Inspect existing infrastructure first and preserve working host definitions, state, secrets, and workflows.
- Copy these patterns into the host repo and adapt them. Do not create or depend on infrastructure flakes or modules shared across repos; improve the patterns upstream in this skill. The only shared module is app-release, imported from the standards flake.
- A dedicated infra repo is a full standards consumer: run `standards init` before laying out infrastructure. There is no partial consumer profile; the synced TypeScript payload stays inert. Put Nix and OpenTofu Dependabot update blocks in `.github/dependabot.local.yml`.

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

## Host names

- Name each host `<env>-<index>`, such as `prod-1`, even in a single-server repo, and never after the repo or product. Replace a host by building `prod-2` beside it, migrating, and retiring `prod-1`, with no rename.
- Use the same name for `nixosConfigurations.<name>`, `deploy.nodes.<name>`, `hosts/<name>/`, and `networking.hostName`. It is also the `just secrets` target of the host's `secrets.yaml`, so it must start with an ASCII letter or digit and contain only letters, digits, dots, underscores, and hyphens.
- Set `networking.domain` to the primary domain the host serves. Manage a DNS record `<name>.<domain>` for the machine in the tofu stack and use it as `deploy.nodes.<name>.hostname`.
- Do not add a stable machine alias such as `server.<domain>`. Product domains are the durable names and repoint at cutover; per-machine names keep two live hosts distinct in logs and SSH targets during a migration.

## Flake

- Inputs: `nixpkgs` on a NixOS release branch, `deploy-rs`, `disko`, `sops-nix`, `treefmt-nix`, and `standards` pinned as `github:davidvornholt/standards/<commit>`. Every other input sets `inputs.nixpkgs.follows = "nixpkgs"`.
- `nixosConfigurations.<name>` imports `disko.nixosModules.disko`, `sops-nix.nixosModules.sops`, `inputs.standards.nixosModules.app-release`, `./modules/base.nix`, `./modules/apps`, and `./hosts/<name>/configuration.nix`.
- `deploy.nodes.<name>.profiles.system` sets `user = "root"` and `path = deploy-rs.lib.${system}.activate.nixos self.nixosConfigurations.<name>`.
- `formatter` is the treefmt wrapper. `checks` holds the treefmt check, each host's `config.system.build.toplevel`, and `deploy-rs.lib.${system}.deployChecks self.deploy`.
- First-party app digests never enter the flake; the host's release state records them.
- Pin third-party images in a digest manifest beside the flake ([vendor images](vendor-images.md)). Modules read it with `builtins.fromJSON (builtins.readFile <relative path to vendor-images.json>)`, derive `repository@digest`, and validate required pins during evaluation, so `nix flake check` checks the configuration that deploys. Do not add empty non-deploy fallbacks.
- Use `specialArgs` only for values supplied from outside the repo, such as the host-local active preview set.

## Server profile

Every new host takes the full profile in `modules/base.nix`; diverging is a decision recorded in the host repo. The values are working defaults.

- Nix: `experimental-features = [ "nix-command" "flakes" ]`, `trusted-users = [ "root" <admin> ]`, and a weekly `nix.gc` with `--delete-older-than 14d`.
- Boot: systemd-boot with `boot.loader.efi.canTouchEfiVariables = true`.
- Users: one admin user with `isNormalUser`, the groups `wheel` and `podman`, and the admin SSH keys. Root's authorized keys are only the CI deploy keys. `security.sudo.wheelNeedsPassword = false`.
- SSH: `PasswordAuthentication = false`, `KbdInteractiveAuthentication = false`, `PermitRootLogin = "prohibit-password"`, and `services.fail2ban.enable = true`.
- Firewall enabled with TCP 22, 80, and 443. Only Caddy publishes services; every further port is a decision recorded in the host repo.
- journald: `SystemMaxUse=1G` and `MaxRetentionSec=14day`.
- `services.caddy.email` set; ACME registration requires it.
- `virtualisation.podman.defaultNetwork.settings.dns_enabled = true`, so containers resolve each other by name, and `virtualisation.oci-containers.backend = "podman"`.
- A `podman-image-prune` oneshot (`Nice = 19`, `IOSchedulingClass = "idle"`) runs `podman image prune --all --force --filter until=168h` from a daily timer with `Persistent = true` and `RandomizedDelaySec = "30m"`.
- Packages: curl, dig, gitMinimal, htop, jq, lsof, rsync, vim.

### Image retention

- Every Podman host needs this production image retention. A preview-only collector, Nix garbage collection, and journal retention do not replace it.
- Do not substitute `podman system prune`, volume pruning, or external-container removal. Podman already protects images that any container references, including stopped containers.
- The age filter uses image creation time, not pull or last-use time, so a rollback may pull a retired image again; keep registry access available.
- When a deployment or preview controller protects staged or rollback images beyond container references, coordinate cleanup with it, or exclude its labels and keep its own collector.
- After deploying, verify the timer and one successful cleanup on each host.
- In a disk-full incident, reclaim unused images, then check PostgreSQL recovery and every service on that filesystem. Never remove database files or volumes to make room.

### Other host roles

- A PostgreSQL host runs a local dump timer with retention; hourly `pg_dump --format=custom` into a `postgres`-owned directory is the norm.
- A GitHub Actions runner host uses `services.github-runners.<name>` with a SOPS-provided token, `programs.nix-ld.enable = true` plus `NIX_LD` and `NIX_LD_LIBRARY_PATH` in the runner environment so downloaded tools run, and systemd caps (`CPUQuota`, `MemoryHigh`, `MemoryMax`) so jobs cannot starve the host's services.

### PostgreSQL (peer auth per app)

Host-managed and local-only. Each app database is owned by the role of the same name, and listed system users peer-authenticate as that role over the socket. Sockets never use passwords; loopback TCP uses scram. Start from this wiring:

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

`hosts/<name>/configuration.nix` holds `networking.hostName`, `networking.domain`, `time.timeZone`, profile parameters (SSH keys, ACME email, databases), app options, SOPS wiring, and `system.stateVersion`, which is set once at install and never changed.

## App modules

- Host-specific services live in `modules/apps/` under the repo's `<repo>.apps.*` options, each gated by an `enable` option.
- They publish through Caddy virtual hosts, run on Podman with digest-pinned images, peer-authenticate to their database as their own system user, and read secrets from SOPS paths.
- A first-party app's module declares its app-release unit and Caddy wiring, never its image digest.
- A host that serves a web app also gets [PR previews](pr-previews.md).

## Secrets (SOPS + age)

Identities, `.sops.yaml`, and CI wiring are in [secrets.md](secrets.md). On a host:

- Add the host key, derived with `ssh-to-age < /etc/ssh/ssh_host_ed25519_key.pub`, as a recipient in the `.sops.yaml` creation rules beside the admin and CI keys.
- Set `sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ]` and `sops.defaultSopsFile = ./secrets.yaml`. Give each app secret `mode = "0400"` and `restartUnits = [ config.services.appRelease.units.<unit>.refreshUnit ]`, so a rotation restarts the app at its current digest.

## OpenTofu root stacks

- One directory per stack under `opentofu/<stack>/`, one state each. Commit `.terraform.lock.hcl`. Write resources inline; there are no shared child modules.
- Declare `required_version = ">= 1.10.0"`, an empty `backend "s3" {}`, and pinned providers such as `cloudflare/cloudflare` at `~> 5.0`, configured empty (`provider "cloudflare" {}`). The workflow or environment injects backend configuration and credentials (R2 is S3-compatible); never hardcode them.
- Non-secret identifiers such as zone IDs, account IDs, and record contents are plain `locals`, which keeps plans reviewable.
- Model collections such as DNS records and buckets as one `for_each` resource over a map keyed by a stable identifier, so a rename is a `moved` block rather than a destroy and create.
- DNS defaults: `ttl = 1` (auto) and `proxied = false`.
- Buckets and other data-bearing resources carry `lifecycle { prevent_destroy = true }`.

## Nix binary cache

A repo whose trusted CI builds and deploys NixOS closures uses a private, signed binary cache: Cloudflare R2 when the repo already has a Cloudflare stack, otherwise any backend with the same trust and access boundaries.

- Declare the bucket in the host's infrastructure home as a data-bearing resource, before any workflow references it.
- Validation holds a bucket-scoped read/write credential and the signing key. Deployment holds a read-only credential and neither of those. Workflow configuration contains only the signing key's public half.
- Validation substitutes from the cache, runs the full Nix gate, then signs and copies the closure of every check output. A failed or partial copy fails validation, which blocks deployment.
- Deployment waits for validation of the exact main-branch commit and substitutes that closure instead of rebuilding.
- The bucket is never publicly readable; for R2, no `r2.dev` hostname and no custom domain. Verify this through the provider API in PR validation and again before deployment.
- Document the credentials, signing-key rotation, and retention policy with the repo's other infrastructure configuration.

## Deploy downtime

Blue-green app releases and definition changes have no downtime ([app-release](app-release.md)). A `recreate` app, a changed third-party container, and a Caddy restart interrupt service briefly; that is the accepted default. A host that cannot accept it records the decision and its wiring in the host repo.

## Private registry access

Workflows read private GHCR packages with their job-scoped `GITHUB_TOKEN`; a host cannot.

- A host that pulls private images keeps one classic GitHub PAT with only the `read:packages` scope at `registry.github_token` in its SOPS host target. Never put it in a Nix expression, the Nix store, an image manifest, or a workflow secret.
- The PAT reads every private package its owner can read. The host repo either names a dedicated package-reader identity limited to the host's packages or records that it accepts this account-wide reach.
- A `podman-ghcr-login` oneshot reads the PAT from stdin, logs in to a `0600` temporary file in the same directory, and renames it to `/run/containers/auth/ghcr-private.json` only after login succeeds. The secret's `restartUnits` include this oneshot.
- The host also creates the root-owned `0600` file `/run/containers/auth/anonymous.json` containing exactly `{"auths":{}}`.
- Every pull names its auth file, private or anonymous, so Podman never falls back to ambient Podman or Docker credentials. Container and migration units that pull set `REGISTRY_AUTH_FILE` and pass `--authfile`. App-release containers run local tags and never pull, so an app-release unit sets only `registryAuthFile`, plus the login unit in `serviceDependencies` for private images. Public images never depend on the login unit.
- Rotate in this order: create a replacement PAT with only `read:packages`; re-check which packages its owner can read; replace `registry.github_token`; deploy and confirm the login unit rewrote the private auth file; force an uncached authenticated pull through that file; then revoke the old PAT. GitHub has no API for classic PATs, so `bun standards creds` does not manage this one.

## Install and convergence

- First install: nixos-anywhere with the disko layout, or a NixOS installer plus `disko`. Capture `hardware-configuration.nix` from the target, then collect the host key and re-encrypt secrets for it.
- A main-branch workflow converges: `nix run .#deploy-rs` with a deploy SSH key only CI holds, only to hosts whose system closure changed, and `tofu apply` gated on the plan job. App releases do not pass through it ([app-release](app-release.md)).
- deploy-rs rolls back inside its SSH session, and that rollback dies when deploy-rs disconnects, which can leave a host half-switched with units stopped. After a failed deployment the workflow therefore waits for deploy-rs on the host to exit, points the system profile back at the pre-deployment system if deploy-rs did not, and activates it again in a `systemd-run` unit, which outlives the session. The job still fails.
- After a successful deployment to a host with app-release units, the workflow runs `app-release check` there with the deploy key. A failing check fails the job without a restore, because the activation succeeded. It is also the only deployment signal for a running recreate app that fails its health check, which the activation's reconcile does not restart.
- PR workflows run only the validation gates, with read-only credentials or `-backend=false`.
- Synced GitHub settings bring branch protection; require the infra PR gates as status checks through `.github/settings.local.json`.
