# Review loop: worker sync reliability

## Scope

- User request: fix unreliable worker mail pickup and unreliable blocking, then run a review loop.
- Starting diff: local working tree changes to worker sync planning, account watcher, reconcile behavior, worker README, and UID planner tests.
- Validation gate: `bun run check:fix` from the repo root.

## Operations

- 2026-07-02 18:21:47 +0200: Root deterministic gate completed before review: `bun run check:fix` passed.
- 2026-07-02 18:21:47 +0200: Ledger opened.
- 2026-07-02 18:22:56 +0200: Review pass 1 completed with one unscoped reviewer invocation and zero retries.
- 2026-07-02 18:22:56 +0200: Validated pass 1 findings; both are real repo-contract blockers and in scope.
- 2026-07-02 18:25:37 +0200: Worker subagent fix pass completed for RL-1 and RL-2.
- 2026-07-02 18:25:37 +0200: Root deterministic gate rerun after fixes: `bun run check:fix` passed.
- 2026-07-02 18:27:16 +0200: Review pass 2 completed with one unscoped reviewer invocation and zero retries; no findings reported.

## Passes

- Pass 1, 2026-07-02 18:22:56 +0200:
  - Delta reviewed: full current implementation diff.
  - Reviewer: unscoped full review.
  - Invocation status: completed.
  - Retry count: 0.
  - Checks run before pass: `bun run check:fix` passed.
- Pass 2, 2026-07-02 18:27:16 +0200:
  - Delta reviewed: full post-fix implementation diff, including untracked helper/test files.
  - Reviewer: unscoped full review.
  - Invocation status: completed.
  - Retry count: 0.
  - Checks run before pass: `bun run check:fix` passed after pass 1 fixes; reviewer also reported `git diff --check` passed.
  - Result: no findings.

## Findings

- RL-1, 2026-07-02 18:22:56 +0200, Blocking, unscoped, `apps/worker/src/features/sync/account-watcher.ts:208`:
  - Summary: `account-watcher.ts` exceeds the repo's 200-line guideline without an explicit exception.
  - Disposition: fixed.
  - Disposition reason: valid AGENTS.md contract issue.
  - Verification after disposition: `account-watcher.ts` is 175 lines; `bun run check:fix` passed at 2026-07-02 18:25:37 +0200.
- RL-2, 2026-07-02 18:22:56 +0200, Blocking, unscoped, `apps/worker/src/features/sync/account-watcher.ts:92` and `apps/worker/src/features/sync/account-watcher.ts:142`:
  - Summary: new periodic polling and IMAP error signal behavior lacks direct tests.
  - Disposition: fixed.
  - Disposition reason: valid AGENTS.md testing issue.
  - Verification after disposition: added `apps/worker/src/features/sync/mailbox-signals.test.ts`; `bun run check:fix` passed at 2026-07-02 18:25:37 +0200.
