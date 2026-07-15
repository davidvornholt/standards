# Review loop ledger: PR preview diff

- Scope: Current working tree diff against `HEAD`, including staged changes, unstaged changes, and untracked files under `apps/web/scripts/`.
- User request: Run a review loop against the current diff.
- Validation gate command: `bun run check:fix`
- Gate status: passed at 2026-06-13 13:41:46 +0200 CEST.

## Operations

- 2026-06-13 13:41:46 +0200 CEST: Ran `bun run check:fix`; lint:fix, check-types, test, build, and test:a11y passed.
- 2026-06-13 13:41:46 +0200 CEST: Created review ledger after the deterministic gate, per review-loop workflow.
- 2026-06-13 13:51:37 +0200 CEST: Completed pass 1 reviewer fan-out with five reviewer invocations and zero retries.
- 2026-06-13 13:51:37 +0200 CEST: Ran focused checks for touched workflow/infra surface: actionlint passed and `nix flake check ./infra --print-build-logs` passed.
- 2026-06-13 14:10:35 +0200 CEST: Worker fix pass 1 completed; root `bun run check:fix`, actionlint, `nix flake check ./infra --print-build-logs`, `bash -n` on changed shell scripts, and `git diff --check HEAD` passed.
- 2026-06-13 14:10:35 +0200 CEST: Completed pass 2 convergence review with one unscoped reviewer invocation and zero retries.
- 2026-06-13 14:30:50 +0200 CEST: Initial pass 3 reviewer spawn failed because completed agents still occupied the thread limit; closed completed agents and retried successfully.
- 2026-06-13 14:30:50 +0200 CEST: Worker fix pass 2 completed; root `bun run check:fix`, actionlint, `nix flake check ./infra --print-build-logs`, `bash -n` on changed shell scripts, and `git diff --check HEAD` passed.
- 2026-06-13 14:30:50 +0200 CEST: Completed pass 3 final convergence review with one unscoped reviewer invocation and zero findings.

## Passes

- Pass 1, 2026-06-13 13:51:37 +0200 CEST
  - Delta reviewed: full current working tree diff against `HEAD`, plus untracked `apps/web/scripts/`.
  - Reviewer invocations: security, GitHub Actions/deploy correctness, infrastructure/configuration architecture, tests/docs/maintainability, catch-all.
  - Invocation status: all completed; retry count 0.
  - Gate/check context: `bun run check:fix` passed before review; focused actionlint and infra flake checks passed during validation.
- Pass 2, 2026-06-13 14:10:35 +0200 CEST
  - Delta reviewed: worker fix delta with full current diff context.
  - Reviewer invocations: one unscoped full convergence reviewer.
  - Invocation status: completed; retry count 0.
  - Gate/check context: post-fix `bun run check:fix`, actionlint, infra flake check, shell syntax, and `git diff --check HEAD` all passed.
- Pass 3, 2026-06-13 14:30:50 +0200 CEST
  - Delta reviewed: second worker fix delta with full current diff context.
  - Reviewer invocations: one unscoped final convergence reviewer; one failed pre-invocation spawn attempt due thread limit.
  - Invocation status: completed; retry count 0 after successful spawn.
  - Gate/check context: post-pass-2 `bun run check:fix`, actionlint, infra flake check, shell syntax, and `git diff --check HEAD` all passed.

## Findings

- RL-001, 2026-06-13 13:51:37 +0200 CEST, Blocking, security, `.github/actions/deploy-pr-preview/scripts/upsert-pr-comment.sh:34`: PR preview comment upsert selects any issue comment containing the marker and can patch a user-authored comment. Disposition: fixed. Verification: bot-owned marker filter added; pass 3 reviewer found no issues; `bun run check:fix`, actionlint, shell syntax, and `git diff --check HEAD` passed.
- RL-002, 2026-06-13 13:51:37 +0200 CEST, Blocking, security/deploy correctness, `infra/modules/apps/web-preview-deploy-lib.sh:184`: preview deploy writes active state and exposes the route before migrations; migration failure leaves a broken active preview preserved by future deploys. Disposition: fixed. Verification: deploy failure now removes active preview state and drops resources; script tests cover migration failure; pass 3 reviewer found no issues; `bun run check:fix`, infra flake check, shell syntax, and `git diff --check HEAD` passed.
- RL-003, 2026-06-13 13:51:37 +0200 CEST, Blocking, security/deploy correctness, `infra/modules/apps/web-preview-deploy-lib.sh:195`: preview destroy removes state before the host switch and only drops the database after the switch, so a failed switch can leave a removed preview publicly reachable. Disposition: fixed. Verification: destroy now drops preview resources before switching host; script test covers ordering; pass 3 reviewer found no issues; `bun run check:fix`, infra flake check, shell syntax, and `git diff --check HEAD` passed.
- RL-004, 2026-06-13 13:51:37 +0200 CEST, Blocking, GitHub Actions/deploy correctness, `.github/actions/deploy-prod/action.yml:142`: deploy step redefines `FESK_PR_PREVIEWS_FILE` from the expression env context instead of using the runner env written through `$GITHUB_ENV`. Disposition: fixed. Verification: step-level override removed; pass 3 reviewer found no issues; actionlint and `bun run check:fix` passed.
- RL-005, 2026-06-13 13:51:37 +0200 CEST, Blocking, GitHub Actions/deploy correctness, `.github/workflows/pr-preview.yml:28`: deploy-preview calls the Pulls API but lacks `pull-requests: read`. Disposition: fixed. Verification: `pull-requests: read` added to deploy-preview permissions; pass 3 reviewer found no issues; actionlint passed.
- RL-006, 2026-06-13 13:51:37 +0200 CEST, Blocking, tests/docs/maintainability, `.github/scripts/resolve-pr-preview-build.sh:33`, `.github/actions/deploy-pr-preview/scripts/validate-inputs.sh:13`, `infra/modules/apps/web-preview-deploy-lib.sh:37`: new PR-preview deploy control paths lack focused tests for validation, artifact resolution, and state mutation. Disposition: fixed. Verification: Bun tests added under `apps/web/scripts/`; `bun run check:fix` passed and includes those tests.
- RL-007, 2026-06-13 13:51:37 +0200 CEST, Non-Blocking, docs, `infra/README.md:141`: threat-model wording says trusted deploy never executes PR code but does run the PR-built image on the host. Disposition: fixed. Verification: wording qualified; pass 3 reviewer found no issues.
- RL-008, 2026-06-13 13:51:37 +0200 CEST, Nit, docs, `README.md:52`: text calls `fesk_web_a11y` a PostgreSQL container, but it is the database name. Disposition: fixed. Verification: wording corrected; pass 3 reviewer found no issues.
- RL-009, 2026-06-13 13:51:37 +0200 CEST, Nit, docs/script consistency, `apps/web/scripts/test-a11y.ts:16`: `up` mode is supported but not exposed or documented. Disposition: fixed. Verification: hidden mode removed; `bun run check:fix` passed.
- RL-010, 2026-06-13 13:51:37 +0200 CEST, Non-Blocking, infrastructure, `infra/modules/apps/web-preview-model.nix:26`: loopback ports are assigned by sorted preview index, so lower PR additions/removals shift higher preview loopback ports. Disposition: discarded. Reason: public preview URLs remain stable and the loopback port is an internal generated implementation detail reconciled by Nix/Caddy; stable port persistence would add state complexity outside the review-loop fix scope. Verification: `nix flake check ./infra --print-build-logs` passed with current model.
- RL-011, 2026-06-13 14:10:35 +0200 CEST, Blocking, deploy correctness, `.github/workflows/pr-preview.yml:20`: failed or cancelled PR preview build runs do not fail closed, leaving an existing preview serving an older commit. Disposition: fixed. Verification: failed non-success workflow runs now destroy same-repository previews; pass 3 reviewer found no issues; actionlint passed.
- RL-012, 2026-06-13 14:10:35 +0200 CEST, Blocking, deploy correctness, `.github/actions/deploy-pr-preview/action.yml:64`: public preview verification failure happens after the host operation, leaving active state and runtime behind. Disposition: fixed. Verification: verification failure now best-effort destroys the preview and updates the comment before failing; pass 3 reviewer found no issues; actionlint and shell syntax passed.
- RL-013, 2026-06-13 14:10:35 +0200 CEST, Blocking, deploy correctness/database lifecycle, `infra/modules/apps/web-preview-deploy-lib.sh:172`: failed update of an existing preview restores old state without restoring the already-migrated database. Disposition: fixed. Verification: failed deploy now removes that PR state and drops preview resources; script tests cover existing-preview migration failure; pass 3 reviewer found no issues.
- RL-014, 2026-06-13 14:10:35 +0200 CEST, Blocking, tests, `.github/actions/deploy-pr-preview/scripts/upsert-pr-comment.sh:34`: comment ownership and patch/post/destroy behavior is changed but untested. Disposition: fixed. Verification: `upsert-pr-comment.sh` Bun tests added for bot marker update, user marker ignore/post, destroy no-op, and pagination; `bun run check:fix` passed.
- RL-015, 2026-06-13 14:10:35 +0200 CEST, Non-Blocking, deploy correctness, `.github/actions/deploy-pr-preview/scripts/upsert-pr-comment.sh:23`: comment lookup only reads the first 100 issue comments, so old marker comments can be missed. Disposition: fixed. Verification: comment lookup paginates until a short page and test covers marker on page 2; pass 3 reviewer found no issues.
- RL-016, 2026-06-13 14:10:35 +0200 CEST, Nit, infrastructure, `infra/modules/apps/web-previews.nix:111`: preview port-capacity assertion rejects the valid final port when `basePort = 65535` and one preview exists. Disposition: fixed. Verification: assertion adjusted to allow last assigned port 65535; infra flake check and pass 3 reviewer found no issues.
