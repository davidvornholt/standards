---
name: github-actions
description: Review and update GitHub Actions workflows safely. Use this skill when editing `.github/workflows/*.yml`, adding or changing `uses:` actions, modernizing workflow versions, or checking whether a touched workflow should upgrade stale action majors.
---

# GitHub Actions

## Overview

Use this skill when a task touches GitHub Actions workflow files or action version selection. It defines how to choose action versions, when to upgrade the rest of a workflow, and which shortcuts are forbidden.

## Workflow rules

- Use the newest published stable major for every `uses:` entry you touch.
- Upgrade stale major versions elsewhere in the same workflow while you are already editing it, unless there is a documented compatibility reason not to.
