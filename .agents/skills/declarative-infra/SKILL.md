---
name: declarative-infra
description: Operating contract for declarative infrastructure (NixOS hosts, OpenTofu stacks). Use when touching host configuration, flakes, secrets or deploy wiring, PR preview environments, or cloud resources (DNS, buckets) — even when the infrastructure's home is another repo.
---

# Declarative infrastructure

## Model

- Infrastructure has exactly one home per host: an `infra/` directory in the repo the host serves, or — usually when one host serves apps from several repos — a dedicated infra repo. If this repo is not that home, make infrastructure changes (virtual hosts, databases, DNS, buckets) in the home repo.
- Apply changes by pushing to GitHub and letting trusted main-branch automation converge. Never run `deploy-rs`, `tofu apply`, or `nixos-rebuild switch` by hand; direct mutation is for emergencies only, and must be flagged when used.
- PR previews are the one sanctioned exception to state-in-git: the active preview set lives in a host-local desired-state file mutated only by a validated forced SSH command, which converges the same flake that defines production. How previews are shaped stays fully declarative; see `references/pr-previews.md`.
- App services run as Podman `oci-containers` with digest-pinned images, published only through Caddy; hosts never run Docker. Wiring details live in `references/bootstrap.md`.

## Changing existing infrastructure

- Restructuring tofu resources uses `moved` blocks; adopting existing resources uses `import` blocks; both stay in the repo as history. Any migration or refactor must show a no-op plan before merging.
- Removing a data-bearing resource (bucket, database, volume) is a deliberate two-step — lift `prevent_destroy`, then destroy — never a plan side effect.

## Validation

Non-mutating gates before pushing: `nix flake check`, build the host toplevel, `tofu fmt -check`, `tofu init -backend=false && tofu validate`, and `tofu plan` where credentials exist. Never let validation become an apply.

## Bootstrap

Creating a new host, repo, or first cloud stack — read `references/bootstrap.md`. Setting up SOPS + age secrets alone, without host infrastructure — read `references/secrets.md`.

A host serving a web app also gets PR preview environments as a default part of adoption — an expected add-on, not something the consumer asks for. Wire them per `references/pr-previews.md`; leaving them out is a documented decision in the host repo.
