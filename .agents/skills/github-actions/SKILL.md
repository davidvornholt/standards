---
name: github-actions
description: Review and update GitHub Actions workflows safely. Use this skill when editing `.github/workflows/*.yml`, adding or changing `uses:` actions, modernizing workflow versions, checking whether a touched workflow should upgrade stale action majors, or wiring quality gates, deploy hard-gates, and branch protection.
---

# GitHub Actions

## Overview

Use this skill when a task touches GitHub Actions workflow files or action version selection. It defines how to choose action versions, when to upgrade the rest of a workflow, and which shortcuts are forbidden.

## Workflow rules

- Use the newest published stable major for every `uses:` entry you touch.
- Upgrade stale major versions elsewhere in the same workflow while you are already editing it, unless there is a documented compatibility reason not to.

## Gates and protection

Quality gates exist to block bad changes mechanically, so wire them so they cannot be skipped. Prefer strict, fail-closed gates whenever it is sensible.

- **Fail closed.** A gating job that errors, times out, or cannot find the run it depends on must FAIL, never pass by default.
- **Hard-gate deployment on the quality gate.** A deploy job must not run unless the quality gate passed for the exact commit being deployed. When the gate lives in a separate workflow, make deploy depend on it — via `workflow_run` on the gate workflow's success, or a fail-closed job that waits for the gate's run on `github.sha` and blocks the deploy chain.
- **Require the gate at merge time too.** Where the plan allows it, protect the default branch (branch protection or a repository ruleset) to require the gate's status check and a pull request, and to block force-pushes and deletions, with no bypass. Merge-gating and deploy-gating cover different moments — entering the branch versus shipping it — so use both when available.
- **Never weaken a gate to make a change pass.** Fix the change, or strengthen the gate.
