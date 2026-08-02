---
name: ci-pipelines
description: Use when adding or changing GitHub Actions workflows, CI jobs, runners, caching, or deploy pipelines. Cost-efficient workflow shapes and the fail-closed patterns that keep the shortcuts safe.
---

# CI pipelines

Every rule here was learned from measured billing on real repositories. GitHub bills per job, per minute, rounded up, and a hosted runner bills while it sleeps — so the shape of the workflow graph is a cost decision, and every cost shortcut needs a fail-closed proof behind it.

## Billing shapes the job graph

- Every job bills a minimum of one minute. Fold sub-minute checks into an existing job on the same trust level instead of giving them their own job.
- Included minutes bill x64 and ARM at the same 1x rate; changing runner architecture for a job inside the allowance saves nothing.
- Never poll or await gates on an expensive runner. Put the waiting in a preflight job on the cheapest runner and start the expensive job once the gates are settled — but keep the security-relevant re-verification inline in the job that acts on it; the preflight only saves billed sleep.

## Skip work only with proof

- Before an expensive gate, classify the actual checked-out diff against the file set the gate reads. Any uncertainty — failed checkout, missing commit, no merge base — selects the gate, never the skip. GitHub's workflow-level `paths` filter reads a bounded list and cannot make this decision; classify in a cheap job.
- A run that concludes "nothing to do" must first prove its precondition, such as the artifacts it relies on actually existing and being published for a proven parent, before cancelling itself.
- When a trusted publisher already built and signed an output, verify the signature instead of rebuilding or re-downloading. Verify per output and rebuild only the misses; an evaluation failure, an absent or wrong-key signature, or any query failure is a miss, never a pass.
- A proof only ever hits if the checked artifact's identity is stable: pin each check's inputs to exactly the files it reads. An input that folds in the whole repository changes identity on every commit and makes the cache permanently useless.

## Caches

- Replay beats rebuild: content-hashed task caches make unchanged workspaces free. Restore on every run, publish only from a successful default-branch run, and bound the cache's size before saving.
- Published snapshots must not accumulate history: build the publishable snapshot from an empty store so it contains only what the current lockfile reaches. Do not rely on a tool's own garbage collection — it can be version-asymmetric, where an older tool cannot recognize artifacts a newer release introduced.
- Large caches such as container layers do not belong in the shared Actions cache quota, where eviction churn silently costs more than the cache saves. Give them owned object storage behind a purpose-scoped credential.
- Executable stores — package caches, browsers — stay at their tool-default paths. Strict-env task runners hide relocated paths from exactly the subprocesses that need them.

## Ordering and failure

- Serialize deployments with FIFO queueing (`concurrency.queue: max`) so a late-finishing run for an older commit cannot evict the pending run for the newest one, and guard the deployment itself against stale commits so ordering mistakes cost latency, never correctness.
- The root contract's fail-closed rule governs every shortcut above: a skip, self-cancel, or cache proof that errors must select the full path or fail the run. A shortcut that can turn an error into a green is a defect, whatever it saves.

## Reference implementation

prosabridge implements the full set for a Nix-deployed stack — diff classifier, publish self-cancel with published-parent proof, signed-cache presence validation with per-output rebuild, R2 BuildKit layer cache, gate preflight, FIFO deploys — and records the measured effects in its `docs/quality/ci-cost-optimization.md`.
