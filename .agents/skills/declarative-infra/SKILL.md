---
name: declarative-infra
description: Use when changing NixOS, OpenTofu, cloud resources, infrastructure secrets, deployments, or provider credentials, even when another repository owns them. Routes changes through the owning repository and trusted deployment path.
---

# Declarative infrastructure

## Ownership and mutation

Each host's infrastructure has exactly one home: the `infra/` directory of the repository it serves, or a dedicated infrastructure repository. Virtual hosts, databases, DNS records, buckets, and deployments for that host change in that home, even when the work starts in another repository.

Live state changes only through the home's reviewed main-branch automation, so production always matches a reviewed commit and the next automated run has no manual change to undo. Running `deploy-rs`, `tofu apply`, or `nixos-rebuild switch` by hand is an emergency measure. If you do it, say so explicitly in your report.

## Changing existing infrastructure

Restructure OpenTofu resources with `moved` blocks and adopt existing ones with `import` blocks. Keep both in the repository afterwards as the record of what happened. A migration or refactor is ready to merge only when its plan is a no-op, because that proves it changes nothing in production.

Data-bearing resources carry `prevent_destroy`, so deleting one takes two changes: the first lifts the guard, the second destroys the resource. Never let a deletion arrive as a side effect of another plan.

## Validation

Before pushing, run `nix flake check`, build each host's toplevel, run `tofu fmt -check`, and run `tofu init -backend=false && tofu validate`. Where credentials are available, also produce a plan. Validation stops at the plan; applying is the job of the main-branch automation.

## References

Read the reference that matches the change:

| Change | Reference |
| --- | --- |
| A new infrastructure home, host layout, Podman and Caddy, PostgreSQL, Nix caching, or deployment behavior | [Bootstrapping a host repo](references/bootstrap.md) |
| SOPS identities and recipients, CI secrets, or brokered provider credentials | [Secrets bootstrap](references/secrets.md) |
| Preview environments | [Pull request previews](references/pr-previews.md) |
| Releasing, rolling back, or hosting a first-party app's container images | [App releases](references/app-release.md) |
| Third-party container updates whose publisher the infrastructure owner doesn't control | [Vendor image updates](references/vendor-images.md) |

Web hosts get pull request previews by default. Leaving them out takes a decision recorded in the host repository.

Development environment layers and where each value is documented belong to the secrets-and-config skill.
