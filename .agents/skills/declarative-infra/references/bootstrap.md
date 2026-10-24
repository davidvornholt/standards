# Bootstrapping a host repo

Bootstrap only when a host or zone has no infrastructure home yet. Connecting an app to an existing server is not a bootstrap: it is an app module plus an [app-release](app-release.md) unit in that host's home. Before laying anything out, inspect the existing infrastructure and keep what works.

Reuse means copying. Copy the patterns below into the host repo and adapt them, and improve the patterns here, upstream, instead of creating infrastructure flakes or modules that several repos depend on. The one shared module is app-release.

A dedicated infra repo is a full standards consumer, so run `standards init` before laying out the infrastructure. There is no partial consumer profile, so the synced TypeScript payload stays in the repo, inert. Put the Nix and OpenTofu Dependabot update blocks in `.github/dependabot.local.yml`.

## Layout

```
infra/
  flake.nix
  flake.lock
  treefmt.nix
  modules/
    base.nix            # server profile baseline
    apps/               # host-specific services, <repo>.apps.<name>, each with enable
  hosts/<name>/
    configuration.nix   # composition + profile parameters; no app logic
    hardware-configuration.nix
    disko.nix
    secrets.yaml        # SOPS-encrypted
  opentofu/<stack>/     # root stacks
.sops.yaml
```

## Host names

- Name each host `<env>-<index>`, such as `prod-1`, even in a single-server repo. The index makes replacement routine: build `prod-2` beside `prod-1`, migrate, and retire `prod-1`, with no rename.
- Use the same name for `nixosConfigurations.<name>`, `deploy.nodes.<name>`, `hosts/<name>/`, and `networking.hostName`.
- Set `networking.domain` to the primary domain the host serves. Manage a DNS record `<name>.<domain>` for the machine in the tofu stack and use it as `deploy.nodes.<name>.hostname`.
- Do not add a stable machine alias such as `server.<domain>`. Product domains are the durable names and repoint at cutover.

## Flake

- Inputs are `nixpkgs` on a NixOS release branch, `deploy-rs`, `disko`, `sops-nix`, `treefmt-nix`, and `standards` pinned as `github:davidvornholt/standards/<commit>` for the [app-release module](app-release.md#host-module). Every other input follows `nixpkgs`.
- `checks` holds the treefmt check, each host's `config.system.build.toplevel`, and `deploy-rs.lib.${system}.deployChecks self.deploy`.
- Pin third-party images in a digest manifest beside the flake ([vendor images](vendor-images.md)). Modules read it with `builtins.fromJSON (builtins.readFile <path>)`, derive `repository@digest`, and validate required pins during evaluation, so `nix flake check` checks the configuration that deploys. Do not add empty non-deploy fallbacks.

## Server profile

Every new host imports the baseline in `modules/base.nix`, and diverging from it is a decision recorded in the host repo. Beyond the usual NixOS hardening and housekeeping, the baseline fixes these choices:

- Root's authorized keys are only the CI deploy keys. People log in as an admin user in `wheel` and `podman`.
- The firewall opens only TCP 22, 80, and 443. Only Caddy publishes services, and every further port is a decision recorded in the host repo.
- Containers run on Podman, with DNS enabled on the default network.
- A `podman-image-prune` oneshot at idle priority runs `podman image prune --all --force --filter until=168h` from a daily timer with `Persistent = true` and `RandomizedDelaySec = "30m"`. Every Podman host needs it, even when other collectors run. The filter goes by image creation time, not last use, so a rollback may pull a retired image again, and hosts must keep registry access.
- A PostgreSQL host runs an hourly `pg_dump --format=custom` timer into a `postgres`-owned directory, with retention.
- A GitHub Actions runner host uses `services.github-runners.<name>` with a SOPS-provided token, systemd CPU and memory caps, and `programs.nix-ld.enable = true` with `NIX_LD` and `NIX_LD_LIBRARY_PATH` in the runner environment, because prebuilt actions binaries need a dynamic loader.

### PostgreSQL (peer auth per app)

PostgreSQL is host-managed and local-only. Each app database is owned by the role of the same name, and listed system users peer-authenticate as that role over the socket. Sockets never use passwords, and loopback TCP uses scram. Start from this wiring:

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

## Host secrets

[Secrets bootstrap](secrets.md) covers identities, `.sops.yaml`, and CI. A host decrypts its `secrets.yaml` with its SSH host key, so add `ssh-to-age < /etc/ssh/ssh_host_ed25519_key.pub` as a recipient of that file's creation rule and set `sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ]`.

## OpenTofu root stacks

- Each stack is one directory under `opentofu/<stack>/` with its own state. Write resources inline, without shared child modules.
- Declare an empty `backend "s3" {}` and configure providers empty, such as `provider "cloudflare" {}`. The workflow or environment injects backend configuration and credentials. R2 is S3-compatible.
- Non-secret identifiers, such as zone IDs, are plain `locals`.
- DNS records default to `ttl = 1` (automatic) and `proxied = false`.

## Nix binary cache

A repo whose trusted CI builds and deploys NixOS closures uses a private, signed binary cache: Cloudflare R2 when the repo already has a Cloudflare stack, otherwise any backend with the same trust and access boundaries.

- Declare the bucket in the host's infrastructure home as a data-bearing resource, before any workflow references it.
- Validation holds a bucket-scoped read/write credential and the signing key. Deployment holds a read-only credential and neither of those. Workflow configuration contains only the signing key's public half.
- Validation substitutes from the cache, runs the full Nix gate, then signs and copies the closure of every check output. A failed or partial copy fails validation, which blocks deployment.
- Deployment waits for validation of the exact main-branch commit and substitutes that closure instead of rebuilding.
- The bucket is never publicly readable, which for R2 means no `r2.dev` hostname and no custom domain. Verify this through the provider API in PR validation and again before deployment.

## Deploy downtime

A `recreate` app, a changed third-party container, and a Caddy restart interrupt service briefly. That is the accepted default. A host that cannot accept it records the decision and its wiring in the host repo.

## Private registry access

Workflows read private GHCR packages with their job-scoped `GITHUB_TOKEN`, but a host cannot.

- A host that pulls private images keeps one classic GitHub PAT with only the `read:packages` scope at `registry.github_token` in its SOPS host target.
- The PAT reads every private package its owner can read. The host repo either names a dedicated package-reader identity limited to the host's packages or records that it accepts this account-wide reach.
- A `podman-ghcr-login` oneshot reads the PAT from stdin, logs in to a `0600` temporary file in the same directory, and renames it to `/run/containers/auth/ghcr-private.json` only after login succeeds. The secret's `restartUnits` include this oneshot.
- The host also creates the root-owned `0600` file `/run/containers/auth/anonymous.json` containing exactly `{"auths":{}}`.
- Every pull names its auth file, private or anonymous, so Podman never falls back to ambient Podman or Docker credentials. Container and migration units that pull set `REGISTRY_AUTH_FILE` and pass `--authfile`. App-release containers run local tags and never pull, so an app-release unit sets only `registryAuthFile`, and for private images also lists the login unit in `serviceDependencies`. Public images never depend on the login unit.

GitHub has no API for classic PATs, so `bun standards creds` does not manage this PAT. Rotate it by hand, in this order:

1. Create a replacement PAT with only `read:packages`.
2. Re-check which packages its owner can read.
3. Replace `registry.github_token`.
4. Deploy, and confirm the login unit rewrote the private auth file.
5. Force an uncached authenticated pull through that file.
6. Revoke the old PAT.

## Install and convergence

- First install uses nixos-anywhere with the disko layout, or a NixOS installer plus `disko`. Capture `hardware-configuration.nix` from the target, then add the host key as a recipient and re-encrypt the host's secrets before the first deployment.
- A main-branch workflow converges the hosts. It runs `nix run .#deploy-rs` with a deploy SSH key that only CI holds, only against hosts whose system closure changed, and runs `tofu apply` gated on the plan job. App releases do not pass through it.
- deploy-rs rolls back inside its SSH session, and that rollback dies when deploy-rs disconnects, which can leave a host half-switched with units stopped. After a failed deployment the workflow therefore waits for deploy-rs on the host to exit, points the system profile back at the pre-deployment system if deploy-rs did not, and activates it again in a `systemd-run` unit, which outlives the session. The job still fails.
- After a successful deployment to a host with app-release units, the workflow runs `app-release check` there with the deploy key. A failing check fails the job without a restore, because the activation succeeded. It is also the only deployment signal for a running recreate app that fails its health check, which the activation's reconcile does not restart.
- PR workflows run only the validation gates, with read-only credentials or `-backend=false`.
- Synced GitHub settings bring branch protection. Add the infra PR gates as required status checks in `.github/settings.local.json`.
