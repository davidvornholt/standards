---
name: declarative-infra
description: Use when changing NixOS, OpenTofu, cloud resources, infrastructure secrets, deployments, or provider credentials, even when another repository owns them. Routes changes through the owning repository and trusted deployment path.
---

# Declarative infrastructure

## Ownership and mutation

Infrastructure has one home per host: the serving repository's `infra/` directory or a dedicated infrastructure repository. Make virtual host, database, DNS, bucket, and deployment changes in that owner.

Apply live changes only through reviewed main-branch automation. Direct `deploy-rs`, `tofu apply`, or `nixos-rebuild switch` is an emergency action and must be reported as such.

## Changing existing infrastructure

- Restructuring tofu resources uses `moved` blocks; adopting existing resources uses `import` blocks; both stay in the repo as history. Any migration or refactor must show a no-op plan before merging.
- Removing a data-bearing resource is a deliberate two-step: lift `prevent_destroy`, then destroy. Never make deletion a plan side effect.

## Validation

Before pushing, run `nix flake check`, build the host toplevel, run `tofu fmt -check` and `tofu init -backend=false && tofu validate`, and obtain a plan where credentials exist. Validation never applies changes.

## References

- For a new infrastructure home or changes to host layout, Podman/Caddy, PostgreSQL, Nix caching, or deployment behavior, read [Bootstrapping a host repo](references/bootstrap.md).
- For SOPS, development environments, CI secrets, or provider credentials, read [Secrets bootstrap](references/secrets.md).
- For preview environments, read [Pull request previews](references/pr-previews.md). They are the default for web-host adoption; omitting them requires a recorded decision in the host repository.
- For image promotion into a dedicated infrastructure repository, read [Image promotion](references/image-promotion.md).
