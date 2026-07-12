---
name: github-actions
description: Review and update GitHub Actions workflows safely. Use this skill when editing `.github/workflows/*.yml`, adding or changing `uses:` actions, modernizing workflow versions, checking whether a touched workflow should upgrade stale action majors, or wiring quality gates, deploy hard-gates, and branch protection.
---

# GitHub Actions

## Workflow rules

- Use the newest published stable major for every `uses:` entry you touch.

## Gates and protection

Quality gates exist to block bad changes mechanically, so wire them so they cannot be skipped. Prefer strict, fail-closed gates whenever it is sensible.

- **Fail closed.** A gating job that errors, times out, or cannot find the run it depends on must FAIL, never pass by default.
- **Hard-gate deployment on the quality gate.** A deploy job must not run unless the quality gate passed for the exact commit being deployed. When the gate lives in a separate workflow, make deploy depend on it.
- **Merge-time protection is declared, not clicked.** The default-branch ruleset and repo merge settings live in canonical `.github/settings.json` (extended by `.github/settings.local.json`); `standards check` fails on drift and `just sync-standards github --apply` converges the live repo. Do not hand-edit rulesets in the GitHub UI or duplicate them in workflow logic.
