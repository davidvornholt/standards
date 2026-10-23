---
name: ci-pipelines
description: Use when changing continuous integration, GitHub Actions workflows, runners, caches, or deployment pipelines. Keeps CI fail-closed.
---

# CI pipelines

CI fails closed. A step that can't establish what it relies on, such as a diff, a signature, or a gate result, takes the full path or fails the run.

Reference external actions by their major-version tag, such as `actions/checkout@v7`, not by commit SHA. The owner accepts the risk that a tag is retargeted, so don't propose SHA pins.

Each job bills at least one minute, so fold sub-minute checks into an existing job that runs at the same trust level.

## GitHub behavior

A workflow-level `paths` filter can't prove that a gate has nothing to check, because GitHub evaluates it against a bounded list of changed files. Classify the checked-out diff in a job instead.

GitHub counts a skipped job as a passing required check. On runs that skip a gate, the job that reports its required check needs another name.

## Caches

Save caches only from successful default-branch runs. Other runs only restore them.

Leave package and browser stores at their tools' default paths. Turbo's strict environment hides the variables that relocate a store from the tools a task spawns.

Never cache image layers with `type=gha`, because their churn in the shared Actions cache quota costs more than the cache saves. Cache them in the image's registry instead, as `type=registry,ref=ghcr.io/<owner>/<image>:buildcache`. Every build reads it, and only default-branch push builds write it, with `mode=max,image-manifest=true,oci-mediatypes=true`. Registry retention must keep the `:buildcache` tag.

## Deployment

Deploy a commit only after the quality gate passed for that exact commit. Serialize deployments with FIFO queueing (`concurrency.queue: max`), because otherwise a late run for an older commit can evict the pending run for the newest one.
