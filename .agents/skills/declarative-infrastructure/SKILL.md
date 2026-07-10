---
name: declarative-infrastructure
description: Guardrails for declarative infrastructure and configuration changes. Use when editing or operating NixOS infrastructure, host configuration, OpenTofu, or related GitHub workflows.
license: MIT
---

# Declarative infrastructure

Apply configuration and infrastructure by pushing changes to GitHub and letting the configured automation converge them. Do not apply changes directly. Avoid direct mutation commands such as `deploy-rs`, `tofu apply`, or `nixos-rebuild switch`. Use direct application only for an emergency.

Reusable building blocks live in [davidvornholt/nix-infra](https://github.com/davidvornholt/nix-infra) and are consumed pinned: NixOS modules through a flake input, OpenTofu child modules through `?ref=` module sources. Improve generic modules upstream in nix-infra; keep host, app, secret, and state specifics in the consuming repo.
