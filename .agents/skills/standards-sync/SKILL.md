---
name: standards-sync
description: Understand and operate the standards sync system. Use this skill before editing any file that might be canonical (synced from davidvornholt/standards), when a change needs to reach every consumer repo, when running or reasoning about `bun standards`, or when testing a canonical change before publishing it upstream.
---

# Standards sync

## Overview

Reusable engineering standards live in one upstream repo, `davidvornholt/standards`, and are mirrored into each consumer by the published `@davidvornholt/standards` CLI. Every file the system owns is in one of two buckets, and the bucket decides who may edit it.

## The two buckets

- **Bucket 1 — synced (upstream-owned, read-only).** Mirrored on every `sync`, including deletions. Listed in `sync-standards.json` under `paths`.
- **Bucket 2 — repo-owned (seeded once, then diverges).** Written from the template's seed dir during `init`, then owned by the consumer. `sync` never touches them. Examples: `biome.jsonc`, `AGENTS.local.md`, `.github/dependabot.yml`, `.sops.yaml`, `secrets/*`, root `package.json`, `turbo.json`, `README.md`.

The lock persists every observed repository-owned seed path, and sync rejects implicit seed-to-managed or managed-to-seed ownership changes before mutation. Legacy locks inherit the complete contract-v1 seed baseline; changing buckets therefore requires an explicit migration rather than a source-manifest edit.

## Per-repo variation goes through a seam, never a local edit

Because bucket-1 files are byte-identical everywhere, every legitimate per-repo customization uses a designated extension seam — extend, never patch:

| Synced (bucket 1)      | Consumer seam (bucket 2)                                     |
| ---------------------- | ------------------------------------------------------------ |
| `biome.base.jsonc`     | `biome.jsonc` extends it                                     |
| `AGENTS.md`            | `AGENTS.local.md` extends it; `CLAUDE.md` points to it       |
| `.github/settings.json` | `.github/settings.local.json` extends its rulesets and environments additively but never overrides canonical state (GitHub layers added rulesets strictest-wins) |

`sync-standards.local.json` is the bucket-2 sync policy seam. Its required `ref` is a qualified branch (`refs/heads/...`), qualified tag (`refs/tags/...`), or full commit SHA; `scheduledSync` controls only scheduled GitHub Actions run enablement, while the weekly cadence remains canonical. A missing file uses the backwards-compatible default of `refs/heads/main` with scheduled sync enabled. Bare local and workflow syncs read the same ref policy, while successful non-dry `sync --ref <ref>` updates it. Manual workflow requests use the `standards-sync` repository dispatch so GitHub loads the privileged workflow from the default branch. The protected `standards-sync` environment admits branches covered by classic branch protection; ruleset-only enforcement does not qualify. The schedule and repository dispatch bind the workflow to the repository's default branch, and canonical classic protection follows that branch when it is renamed. Store a fine-grained PAT with Contents, Pull requests, and Workflows repository permissions set to write separately as its `STANDARDS_SYNC_ENVIRONMENT_TOKEN` environment secret; the workflow passes the selected credential to checkout's persisted Git authentication and to `GH_TOKEN`.

For an initialized consumer, bare sync validates `sync-standards.lock` before source selection and uses its `upstream`; the managed `sync-standards.json` can therefore be repaired instead of selecting its own replacement. Only an explicit `--from` overrides locked source authority, while a lockless legacy consumer falls back to its managed manifest.

The installed preflight requires `@davidvornholt/standards` >=0.5.0 declared as an exact direct development dependency for every policy, including the default. The checked-in explicit-ESM action validates that declaration before setup; after fetch but before mirror, the CLI also requires `"syncPolicyContractVersion": 1` in the source manifest so pre-contract snapshots cannot delete or downgrade the controller. Contract-v1 sources must not manage the repository-owned control seams `.standards-transaction-cleanup`, `.standards-transaction`, `.standards-transaction-reservation`, `.github/settings.local.json`, `AGENTS.local.md`, `biome.jsonc`, or `sync-standards.local.json`. For the v0.4 upgrade order and legacy secret cleanup, follow the [published package migration guide](https://github.com/davidvornholt/standards/tree/main/packages/standards-cli#upgrade-from-v04).

If a task seems to require editing a canonical file for one repo's needs, stop — the change either belongs upstream (it's a real standard) or in the seam (it's repo-specific).

## Commands

Run commands as `bun standards <command>`; `help` lists them.

## GitHub settings

`github --check` verifies the declared repository settings, canonical classic protection on the repository's actual default branch, exact repository-wide ruleset set, and declared environment policies against the live repository and fails closed on drift or API errors; `github --apply` converges them. The `repository` object accepts exactly 7 keys: `allow_auto_merge`, `allow_merge_commit`, `allow_rebase_merge`, `allow_squash_merge`, `delete_branch_on_merge`, `squash_merge_commit_message`, and `squash_merge_commit_title`. Any other repository key fails before any API request. The canonical declaration currently owns all 7 repository keys, so `.github/settings.local.json` keeps `repository` empty and currently extends only `rulesets` and `environments`; declaring a canonically owned repository key locally is a collision that fails instead of overriding canonical state. Repository ruleset declarations are active branch rulesets with explicit ref-name conditions, no bypass actors, and unique supported `deletion`, `non_fast_forward`, `required_linear_history`, `pull_request`, or `required_status_checks` rules; unknown fields and malformed parameters must fail before any API request. Repository identity and lifecycle keys (`default_branch`, `name`, `private`, `visibility`, `archived`, and `is_template`) are outside this contract and must be rejected in either declaration before any API request. Classic protection declarations must set `required_signatures` to `false`. Check must prove classic protection exists from the public branch summary before an admin-only detail 401, 403, or concealment 404 can be treated as unverifiable. Missing or null `required_status_checks` and `required_pull_request_reviews` detail sections are valid disabled live state and therefore drift from enabled canonical policy; malformed present objects fail closed. Apply requires readable details, validates the complete managed live state before any write, repairs disabled optional sections, verifies classic protection after updating it, and deletes undeclared rulesets last. For each declared environment name, the commands reconcile its exact protection and protected-branch policy. Custom branch or tag policy declarations are unsupported; a live custom mode is drift that apply replaces with one environment update without reading or mutating branch-policy entries. Only the `wait_timer`, `required_reviewers`, and single `branch_policy` protection rule types are supported; unknown, duplicate, missing, or inconsistent branch-policy rules fail closed. Custom GitHub App deployment protection gates are intentionally unsupported declaration state: check reports every enabled gate as undeclared drift and apply disables it only after the environment protection update succeeds. They neither list nor delete undeclared environments because doing so could destroy scoped secrets. The protected `standards-sync` environment admits branches covered by classic protection, not rulesets alone. The schedule and repository dispatch bind the workflow to the repository's default branch, while required-check producers use the live default-branch identity. Apply never lists, reads, or writes secret values: separately store the workflow PAT as the environment secret `STANDARDS_SYNC_ENVIRONMENT_TOKEN`. Apply needs admin auth (the local `gh` CLI or `GH_TOKEN`), which CI's token cannot hold, so drift found in CI is fixed by a human or local agent running `bun standards github --apply`. Never hand-edit declared classic protection, rulesets, environment policies, or merge settings in the GitHub UI; change the declaration instead.

A PR that changes the declaration fails its own gate until the change is applied: run `github --apply` from that branch before merging. Live state converging ahead of the merge is fine — the declaration is authoritative, not the merge order.

## Testing a canonical change before publishing

`sync` with a github/URL source uses `sync-standards.local.json` unless `--ref` selects and persists another qualified ref — but any ref must exist on the remote, so the only way to try an *unpushed* change is a **local-path `--from`**: point a consumer at your local standards clone with uncommitted edits. A local path temporarily overrides the source without changing or applying the configured remote ref.

```sh
# In the CONSUMER, sourcing from a local standards clone with uncommitted edits:
bun standards sync --from ../standards --dry-run   # preview
bun standards sync --from ../standards             # apply
bun run check                                      # see the effect
```

**Critical caveat — throw the result away afterward.** `sync` rewrites the lock from whatever source you pointed at, so a local-path sync records the hash of your *uncommitted* change and a `sha` that is your local HEAD (or the literal `local` if the source is not a git checkout) — a state that does not exist upstream. `check` then passes locally against that lock, which is false comfort. So: test, then discard.

```sh
git restore -- sync-standards.lock <files-the-sync-touched>   # discard the local-sourced state
# then publish for real: push the change upstream, and in the consumer run
bun standards sync                                            # real sync from configured remote ref → commit files + lock
```
