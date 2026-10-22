---
name: ci-pipelines
description: Use when changing continuous integration, GitHub Actions workflows, runners, caches, or deployment pipelines. Keeps cost-saving shortcuts fail-closed.
---

# CI pipelines

Every shortcut that saves work must fail closed: a skip, self-cancel, or proof that errors selects the full path or fails the run.

Canonical workflows reference external actions by their maintained major-version tag, such as `actions/checkout@v7`, not by commit SHA. The owner accepts the small risk that an upstream tag is retargeted, so don't propose SHA pins.

## Billing shapes the job graph

GitHub bills each job by the minute, rounded up, with a one-minute minimum. Fold sub-minute checks into an existing job that runs at the same trust level instead of giving them their own.

Within the included minutes, x64 and ARM runners bill at the same rate, so switching a job's architecture saves nothing there.

A runner bills while it waits. When an expensive job depends on other gates, wait in a preflight job on the cheapest runner and start the expensive job once the gates have settled. The preflight only saves billed sleep: repeat any security check it made, such as confirming the gate passed for the exact commit, inside the job that acts on it.

## Skip work only with proof

Skip an expensive gate only when a cheap job has shown it has nothing to check: classify the checked-out diff against the files the gate reads, and select the gate whenever the result is uncertain. A workflow-level `paths` filter can't decide this, because GitHub evaluates it against a bounded list of changed files.

A run that decides there is nothing to do and cancels itself must first prove why: the artifacts it relies on exist and were published for a proven parent commit.

When a trusted publisher has already built and signed an output, verify the signature instead of rebuilding it. Check each output separately and rebuild only the misses.

Such proofs only hit when an output's identity stays stable across commits that don't touch it, so pin each check's inputs to exactly the files it reads.

Draft pull requests skip the expensive gates, and `ready_for_review` runs them on the current head. GitHub counts a skipped job as a passing required check, so on drafts the job that reports the required check must use another name, leaving the check missing until the ready run reports it. `standards.yml` names its aggregator `check` only on non-draft runs. Give draft and ready runs separate concurrency groups too: GitHub can start a draft run after the ready run that followed it, and in a shared group the draft run cancels the ready one.

A push to the default branch may reuse a pull request's result instead of repeating the gate, because squash-merging an up-to-date branch pushes exactly the tree the pull request run validated. Reuse only when that run recorded the tree it validated and the record matches the pushed tree. Before trusting the record, confirm that it comes from a successful `pull_request` run of the same workflow, for a head in the same repository, with successful gate jobs.

## Caches

Restore caches on every run. Publish them only from a successful default-branch run, and bound their size before saving.

A default-branch run that reuses a result publishes nothing, but cache freshness must not decide whether to reuse: a merge that changes the lockfile, such as a Dependabot update, never finds a snapshot for the new lock and would wait for a full gate on its release path. Instead, when trusted snapshots for the current lockfile are missing or the per-commit snapshots are old, request a separate default-branch publication run that nothing on the release path waits for.

Build publishable snapshots from an empty store, so they contain only what the current lockfile reaches instead of everything they ever held. Don't rely on the tool's own garbage collection for this: an older version of the tool can't recognize artifacts a newer release introduced.

Large caches such as container layers belong in owned object storage behind a credential scoped to that purpose. In the shared Actions cache quota, their eviction churn costs more than the cache saves, so never use `type=gha` for image layers. A repository without owned object storage uses a registry cache, `type=registry,ref=ghcr.io/<owner>/<image>:buildcache`. Every build reads it, and only default-branch push builds write it, with `mode=max,image-manifest=true,oci-mediatypes=true`. Registry retention must keep the `:buildcache` tag.

Leave executable stores, such as package caches and browser downloads, at their tools' default paths. Task runners with a strict environment, such as Turbo, don't pass the variable that relocates a store to the subprocesses that need it.

## Deployment

Deploy a commit only after the quality gate passed for that exact commit. A missing or failed lookup fails the deployment.

Serialize deployments with FIFO queueing (`concurrency.queue: max`). Otherwise a late-finishing run for an older commit can evict the pending run for the newest one. Also guard the deployment itself against stale commits.
