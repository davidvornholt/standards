---
name: declarative-infra
description: Design, bootstrap, and safely change self-contained declarative infrastructure (NixOS hosts, OpenTofu stacks). Use when creating or editing host configuration, flakes, disko/SOPS/deploy wiring, cloud resources (DNS, buckets), convergence workflows — or when a repo still consumes the retired davidvornholt/declarative-infra flake.
---

# Declarative infrastructure

## Model

- Each repo owns its infrastructure completely: flake and locks, host modules, hardware and disko configuration, SOPS secrets, OpenTofu root stacks and state. There is no shared infrastructure dependency — this skill is the reuse mechanism. Instantiate its reference material and adapt it to the host; never add abstraction for hypothetical other consumers.
- Apply changes by pushing to GitHub and letting trusted main-branch automation converge. Do not run `deploy-rs`, `tofu apply`, or `nixos-rebuild switch` by hand; direct mutation is for emergencies only, and must be flagged when used.
- Pull requests evaluate, build, and plan. They never mutate.

## Server profile

The contract every host follows unless its repo documents a deliberate divergence. New hosts take every item. When editing an existing host, diff what you touch against this list and report drift rather than silently normalizing or preserving it.

- systemd-boot with writable EFI variables; flakes + nix-command enabled; weekly GC deleting generations older than 14 days.
- One non-root admin user: wheel, passwordless sudo, SSH keys only. Root SSH restricted to deploy keys (`prohibit-password`).
- sshd: no password or keyboard-interactive auth. fail2ban: 5 retries, 1 h ban.
- Firewall on; only 22/80/443 open. Every additional port is a documented decision in the host repo.
- journald capped: 1 G, 14 days.
- Caddy terminates TLS with an ACME contact email; services publish only through it.
- Containers run on Podman (DNS-enabled default network) as the `oci-containers` backend; images pinned by digest.
- PostgreSQL host-managed and local-only: peer auth per app database/system-user pair, scram only on loopback TCP, never passwords on sockets.
- Hourly local `pg_dump` (custom format) with retention, directory owned by `postgres`.
- Secrets SOPS-encrypted in-repo, decrypted by the host's SSH key; no plaintext secrets in the Nix store or workflow env.

## Procedures

- **New host or repo** — read `references/bootstrap.md` for the repo layout, flake skeleton, SOPS and deploy wiring, and convergence workflows; instantiate services from `references/nixos.md` and cloud resources from `references/opentofu.md`.
- **Change an existing host** — preserve working state: hardware configuration, disko layout, `system.stateVersion`, secrets, state backends. Read only the reference section the change touches.
- **Cloud resources** — `references/opentofu.md`. Root stacks own backend, provider config, credentials, and `import`/`moved` blocks.
- **Repo still imports `github:davidvornholt/declarative-infra`** — that flake is retired. Migrate when touching infra: vendor the equivalents from `references/nixos.md`, inline tofu child modules into the root stack with `moved` blocks and a no-op plan, drop the input.

## Validation

Non-mutating gates before pushing: `nix flake check`, build the host toplevel, `tofu fmt -check`, `tofu init -backend=false && tofu validate`, and `tofu plan` where credentials exist. Migrations and refactors must show a no-op plan. Never let validation become an apply.
