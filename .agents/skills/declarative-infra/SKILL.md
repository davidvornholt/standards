---
name: declarative-infra
description: Set up and safely change opinionated declarative infrastructure using davidvornholt/declarative-infra. Use when bootstrapping a repository's NixOS or OpenTofu layout, consuming or updating the shared modules, editing host configuration, or changing related GitHub convergence workflows.
---

# Declarative infrastructure

Apply configuration and infrastructure by pushing changes to GitHub and letting the configured automation converge them. Do not apply changes directly. Avoid direct mutation commands such as `deploy-rs`, `tofu apply`, or `nixos-rebuild switch`. Use direct application only for an emergency.

Reusable building blocks live in [davidvornholt/declarative-infra](https://github.com/davidvornholt/declarative-infra) and are consumed pinned: NixOS modules (`davidvornholt.*` options) through a flake input, OpenTofu child modules through `?ref=` module sources. Improve generic modules upstream in declarative-infra; keep host, app, secret, and state specifics in the consuming repo.

## Set up a consumer

1. Inspect existing infrastructure first. Preserve working host definitions, state, imports, secrets, and deployment workflows.
2. Keep the consumer as the source of truth for flake composition and locks, hardware and disko configuration, SOPS recipients and encrypted secrets, OpenTofu root stacks and backends, application modules, and deployment topology.
3. Add `github:davidvornholt/declarative-infra` as a flake input, make its `nixpkgs` and `treefmt-nix` inputs follow the consumer when those inputs already exist, and import `nixosModules.default` before local host/application modules.
4. Enable only the opinionated `davidvornholt.*` modules the host needs. Do not add hypothetical options or split modules merely to make them generally configurable.
5. Consume OpenTofu child modules from tagged `?ref=` sources. Keep provider configuration, credentials, backend, state, imports, and `moved` blocks in the consumer root stack.
6. Wire pull requests to evaluate/build and plan without mutation; let trusted main-branch automation perform convergence.

## Change a shared module

Treat current opinions as part of the contract. Change or parameterize one only when a real consumer requirement conflicts with it. Add a contract evaluation for the intended behavior, change the module upstream, validate it there, then update the consumer pin in a separate reviewable change.

## Validate

Run non-mutating gates: `nix flake check`, relevant Nix builds or dry activation, `tofu fmt -check`, `tofu init -backend=false`, `tofu validate`, and plans where credentials are available. Never turn validation into an apply.
