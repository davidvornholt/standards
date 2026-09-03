---
name: ci-pipelines
description: Use when changing continuous integration, GitHub Actions workflows, runners, caches, or deployment pipelines. Keeps cost-saving shortcuts fail-closed.
---

# CI pipelines

## Billing shapes the job graph

- Jobs bill per minute, rounded up, minimum one. Fold sub-minute checks into an existing job on the same trust level instead of giving them their own.
- Included minutes bill x64 and ARM at the same 1x rate; changing runner architecture for a job inside the allowance saves nothing.
- Runners bill while they sleep. Put gate-waiting in a preflight job on the cheapest runner and start the expensive job once the gates are settled; keep security-relevant re-verification inline in the job that acts on it.

## Skip work only with proof

- Before skipping an expensive gate, classify the checked-out diff against the file set the gate reads; any uncertainty selects the gate. The workflow-level `paths` filter reads a bounded list and cannot make this decision — classify in a cheap job.
- A run that concludes "nothing to do" must first prove its precondition — the artifacts it relies on exist and were published for a proven parent — before cancelling itself.
- When a trusted publisher already signed an output, verify the signature instead of rebuilding. Verify per output, rebuild only the misses, and treat every evaluation, signature, or query failure as a miss.
- Proofs only hit when identities are stable: pin each check's inputs to exactly the files it reads. An input that folds in the whole repository invalidates on every commit and makes the proof permanently useless.

## Caches

- Restore on every run; publish only from a successful default-branch run; bound the size before saving.
- Publishable snapshots must not accumulate history: build them from an empty store so they contain only what the current lockfile reaches. Do not rely on a tool's own garbage collection — it is version-asymmetric; an older tool cannot recognize a newer release's artifacts.
- Large caches such as container layers belong in owned object storage behind a purpose-scoped credential, not in the shared Actions quota, where eviction churn costs more than the cache saves.
- Executable stores stay at their tool-default paths; strict-env task runners hide relocated paths from exactly the subprocesses that need them.

## Ordering and failure

- Deployment requires a passing quality gate for the exact commit deployed. A missing or failed lookup fails the deployment.
- Serialize deployments with FIFO queueing (`concurrency.queue: max`) so a late-finishing run for an older commit cannot evict the pending run for the newest one, and guard the deployment itself against stale commits, so ordering mistakes cost latency, never correctness.
- Every shortcut above obeys the root fail-closed rule: a skip, self-cancel, or proof that errors selects the full path or fails the run — never a green.
