---
name: declarative-infra
description: Operating contract for declarative infrastructure (NixOS hosts, OpenTofu stacks). Use when touching host configuration, flakes, secrets or deploy wiring, PR preview environments, or cloud resources (DNS, buckets) — even when the infrastructure's home is another repo — or when a task needs a provider credential or API token.
---

# Declarative infrastructure

## Model

- Infrastructure has exactly one home per host: an `infra/` directory in the repo the host serves, or — usually when one host serves apps from several repos — a dedicated infra repo. If this repo is not that home, make infrastructure changes (virtual hosts, databases, DNS, buckets) in the home repo.
- Apply changes by pushing to GitHub and letting trusted main-branch automation converge. Never run `deploy-rs`, `tofu apply`, or `nixos-rebuild switch` by hand; direct mutation is for emergencies only, and must be flagged when used.
- PR previews are the one sanctioned exception to state-in-git: the active preview set lives in a host-local desired-state file mutated only by a validated forced SSH command, which converges the same flake that defines production. How previews are shaped stays fully declarative; see `references/pr-previews.md`.
- App services run as Podman `oci-containers` with digest-pinned images, published only through Caddy; hosts never run Docker. Wiring details live in `references/bootstrap.md`.
- When the home is a dedicated infra repo, public-image freshness is automation-owned: the source repo announces new digests via `repository_dispatch`, the home repo bumps its committed desired state through its own gates, and completion requires the exact infra merge SHA plus healthy exact-digest readback from every target — see `references/image-promotion.md`.
- Provider credentials are written directly into SOPS targets by `bun standards creds`. Cloudflare tokens the broker minted are renewed and revoked by `plan` / `apply`, while one private GitHub App per repository owner lets workflows mint short-lived installation tokens for selected repositories. `creds add github` selects the App by destination owner and verifies its installation before writing. A token the broker did not mint is never touched by `plan` / `apply`. They list unexpired ones — an expired token is left out, because it grants nothing — each with the `bun standards creds revoke --account <account-id> --token-id <id>` that retires it, which is how a leftover hand-made Cloudflare token is cleaned up. Two listed shapes are exceptions that `revoke` refuses. A token named `standards-broker` holds the reserved name for a machine's broker bootstrap credential, so it is another machine's or a superseded one on this machine, `revoke` refuses it by name, and the listing sends it to the Cloudflare dashboard. A token brokered to a repository whose name differs from this checkout's origin only in capitalisation is listed as brokered elsewhere with a `--force` command that fails, because `revoke` compares repository names case-insensitively and reads the token as this checkout's own; re-point the origin remote at the capitalisation the token carries, or retire it in the dashboard. A third shape blocks rather than listing: a name claiming this repository's `standards/` namespace that the broker does not mint is a finding that aborts reconciliation repository-wide before any mutation, until it is renamed in the dashboard or revoked with the command the finding prints. GitHub App keys rotate manually through the App settings page. Do not claim `creds apply` rotates them, do not ask the operator to create brokered Cloudflare tokens by hand, and do not send them to the Cloudflare dashboard for a token `revoke` will take.
- Trusted CI that builds and deploys NixOS closures uses a signed binary cache: validation publishes only after the full Nix gate passes, and deployment reads the validated closure with separate read-only credentials instead of rebuilding it. Leaving the cache out is a documented decision in the host repo; see `references/bootstrap.md#nix-binary-cache`.

## Changing existing infrastructure

- Restructuring tofu resources uses `moved` blocks; adopting existing resources uses `import` blocks; both stay in the repo as history. Any migration or refactor must show a no-op plan before merging.
- Removing a data-bearing resource (bucket, database, volume) is a deliberate two-step — lift `prevent_destroy`, then destroy — never a plan side effect.

## Validation

Non-mutating gates before pushing: `nix flake check`, build the host toplevel, `tofu fmt -check`, `tofu init -backend=false && tofu validate`, and `tofu plan` where credentials exist. Never let validation become an apply.

## Bootstrap

Creating a new host, repo, or first cloud stack — read `references/bootstrap.md`. Setting up SOPS + age secrets alone, without host infrastructure — read `references/secrets.md`.

A host serving a web app also gets PR preview environments as a default part of adoption — an expected add-on, not something the consumer asks for. Wire them per `references/pr-previews.md`; leaving them out is a documented decision in the host repo.
