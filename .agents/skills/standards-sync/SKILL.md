---
name: standards-sync
description: Understand and operate the standards sync system. Use this skill before editing any file that might be canonical (synced from davidvornholt/standards), when a change needs to reach every consumer repo, when running or reasoning about `bun standards`, or when testing a canonical change before publishing it upstream.
---

# Standards sync

## Overview

Reusable engineering standards live in one upstream repo, `davidvornholt/standards`, and are mirrored into each consumer by the published `@davidvornholt/standards` CLI. Every file the system owns is in one of three buckets, and the bucket decides who may edit it.

## The three buckets

- **Bucket 1 — synced (upstream-owned, read-only).** Mirrored on every `sync`, including deletions. Listed in `sync-standards.json` under `paths`.
- **Bucket 2 — repo-owned (seeded once or created by the consumer, then diverges).** Seeded files are written from the template's seed dir during `init`; other designated seams can be created when needed. `sync` never touches either kind. Examples: `biome.jsonc`, `AGENTS.local.md`, `local.just`, `.github/dependabot.local.yml`, `.sops.yaml`, `secrets/*`, `config/*`, root `package.json`, `turbo.json`, `README.md`.
- **Bucket 3 — generated (engine-owned output).** Recomposed by every `init`/`sync` (and by `dependabot --write`) from a bucket-1 source plus a bucket-2 seam; hand edits are drift that `check` flags. Currently: `.github/dependabot.yml`, composed from `.github/dependabot.base.yml` + `.github/dependabot.local.yml`.

## Symlinks are first-class managed paths

A bucket-1 path may be a symlink. The engine mirrors the link itself and never follows it: `sync` recreates the link in each consumer, and only the link is locked, never the paths under it. The lock entry is a hash like every other one — sha256 over the link target prefixed with a NUL-delimited marker — so it is indistinguishable in shape from the content hashes beside it, and the target string itself never appears in `sync-standards.lock`. A linked directory therefore stays one copy on disk instead of being duplicated under both names. `check` reads a retargeted link — or a link a consumer replaced with a real directory — as drift, exactly as it reads an edited file.

`init`/`sync` check two ownership rules across the whole payload before their first write and report every path that breaks either of them in one run, so these refusals leave the consumer exactly as it was: a canonical link is rejected when its target would resolve outside the repository (empty, absolute, drive-qualified such as `C:/…`, backslash-separated, or climbing out through `..`), and a managed destination is rejected when it is a directory holding paths the lock does not record — whether or not the lock records the destination itself, because a consumer can replace a link the engine wrote with a directory of its own work, and that work is still its own. That second rule is the adoption guard — the engine never deletes a directory of consumer work to make room for a managed path — and it is about directories only: a pre-existing canonical *file* is still overwritten, which is the intended hard cutover. The two rules are not a general pre-flight check; an unrelated conflict, such as a consumer file sitting where a managed path needs a directory, still fails partway through a run. The same ownership rule governs removal: when a locked path upstream dropped has become an unmanaged directory, `sync` reports it `left in place` with the reason and does not delete it, and when it now sits below a symlink, `sync` drops the lock entry and deletes nothing through the link.

`.claude/skills -> ../.agents/skills` is the case this exists for: skills stay at the tool-agnostic `.agents/skills` path that Codex and the `AGENTS.md` routing rule use, while Claude Code discovers them natively at the only path it scans. A consumer's own skills live beside the canonical ones at `.agents/skills/<name>/` — see the seam table below.

Known limitation: git materializes symlinks on Windows only when the checkout sets `core.symlinks=true`. Without it git writes a plain text file containing the link target, so Claude Code finds no skills there, and the file's hash can never equal the link digest in the lock: `check` reports `.claude/skills` as modified on every run and the quality gate is permanently red. `sync` does not rescue such a checkout — it recreates a real symlink, which Windows creates only under Developer Mode or elevation and which the next checkout turns back into a text file. Set `core.symlinks=true` before cloning, or work in WSL.

## Per-repo variation goes through a seam, never a local edit

Because bucket-1 files are byte-identical everywhere, every legitimate per-repo customization uses a designated extension seam — extend, never patch:

| Synced (bucket 1)      | Consumer seam (bucket 2)                                     |
| ---------------------- | ------------------------------------------------------------ |
| `biome.base.jsonc`     | `biome.jsonc` extends it                                     |
| `AGENTS.md`            | `AGENTS.local.md` extends it; `CLAUDE.md` points to it       |
| `justfile`             | `local.just` is imported when present; repo-specific recipes and modules live there, while cross-repo operator workflows stay in the canonical root `justfile` |
| `.github/settings.json` | `.github/settings.local.json` extends it (additive only: it may add repository settings, rulesets, and labels but never override canonical ones — GitHub layers rulesets strictest-wins, and canonical label names are read-only; the one subtractive declaration is `"rulesetEnforcement": "unavailable-on-plan"` for repos whose GitHub plan cannot enforce rulesets) |
| `.github/dependabot.base.yml` | `.github/dependabot.local.yml` extends it through a deliberately lean additive seam: new update blocks for repo-specific ecosystems such as nix or opentofu, top-level private registry definitions, and `ignore` or `registries` entries appended by repeating a canonical normalized target. Matching blocks cannot add labels, groups, cooldowns, pull-request limits, or other policy. The pair is composed into the generated `.github/dependabot.yml`; canonical version holds — with reason and lift condition in comments — live in the base and reach every consumer on sync |
| `.claude/skills` (a link to `.agents/skills`) | your own skills go in `.agents/skills/<name>/`, beside the canonical ones: an unmanaged sibling under a managed directory is never in the lock, so `sync` leaves it alone and it surfaces through the link (`ls .claude/skills` lists it with the canonical skills). Never create `.claude/skills/<name>/` — that turns the managed link's destination into a directory of unmanaged work, and `init`/`sync` refuse to touch the repository until it moves |
| `.github/workflows/standards-sync.yml` | `sync-standards.local.json` configures it (the only policy source since CLI 0.7.0; optional `autoSync` opt-out for the weekly run, optional `ref` pin honored by the workflow and by CLI `init`/`sync`) |

If a task seems to require editing a canonical file for one repo's needs, stop — the change either belongs upstream (it's a real standard) or in the seam (it's repo-specific).

The weekly workflow's writer identity is not a per-repo policy seam. It requires `ci.broker_app.app_id` and `ci.broker_app.private_key` in the SOPS-encrypted `secrets/ci.yaml`, provisioned with `bun standards creds add github --dest ci:ci.broker_app` after installing that repository owner's private broker App only on the selected repository. The command selects by repository owner and verifies the installation before writing. The workflow resolves those nested values before sync and mints two short-lived current-repository tokens: a branch writer with Contents write and Workflows write, because the canonical payload owns `.github/workflows/**`, and a PR opener with Contents read and Pull requests write. Both mint before sync as fail-closed permission preconditions, but neither token enters the sync process; each is exposed only to its post-sync operation. There is no durable-token or workflow-token fallback. The fixed GitHub-hosted `check` aggregator holds no credential at all, so `ci.broker_app` is the only durable GitHub credential a consumer stores.

## Commands

Run commands as `bun standards <command>`; `help` lists them.

## GitHub settings

`github --check` verifies the live GitHub repository (merge settings, rulesets, and declared labels) against the merged declaration and fails closed on drift, API errors, and declared state the token cannot see. GitHub's REST API hides merge settings from read-only viewers (check retries those keys over GraphQL, which serves them to read-only tokens) and requires Issues read (or Pull requests read) to list labels in private repositories. REST serves ruleset `bypass_actors` only to a user-scoped token holding repository Administration read — an admin-authenticated local `gh` CLI qualifies; a GitHub App installation token never does, at any permission level, so CI never sees the actor identities — so check retries the hidden lists over GraphQL, which withholds the actor identities but answers an exact bypass-actor count (established for a GitHub App installation token and for a non-admin classic-scope viewer, not for every identity class): a declared-empty list verifies exactly, a count that disagrees with the declared length is drift, and a matching non-zero count leaves which actors bypass unconfirmed, so that ruleset fails closed until the check is re-run locally with admin `gh` auth. Widening what CI reads with is not the fix. CI therefore verifies with the workflow token and no durable credential: a private-repository probe compared a broker App installation token against a token holding exactly the `check` aggregator job's grants across every read the check performs, and the answers were identical, so minting one would add no visibility while decrypting the App key consumers keep for the weekly sync. The canonical workflow runs the comparison inside its `check` aggregator job, which sparse-checks out only the declarative settings inputs, grants the workflow token only `contents: read` and `issues: read`, and runs a checksum-pinned published CLI outside repository-controlled package configuration. Its unprivileged quality step sets `STANDARDS_SKIP_GITHUB_CHECK=true` so `bun run check` prints a diagnostic and leaves the one live comparison to the aggregator job; this exact-value environment seam is workflow-internal, and local checks remain fail-closed. `github --apply` is never skipped and converges the live repository — creating, updating, and deleting rulesets to exactly the declared set — then re-diffs the PATCH response so a setting GitHub accepts with HTTP 200 but silently ignores is a reported failure, not a false success. Apply needs admin auth (the local `gh` CLI or `GH_TOKEN`), which CI's token cannot hold, so drift found in CI is fixed by a human or local agent running `bun standards github --apply`. Never hand-edit rulesets or merge settings in the GitHub UI; change the declaration instead.

A PR that changes the declaration fails its own gate until the change is applied: run `github --apply` from that branch before merging. Live state converging ahead of the merge is fine — the declaration is authoritative, not the merge order.

GitHub only enforces rulesets on private repositories on paid plans, and the failure modes differ: personal accounts answer ruleset reads with HTTP 403, while free-plan organizations accept rulesets and report them as active but silently do not enforce them — a green comparison there would be a lie. A repo in that position declares `"rulesetEnforcement": "unavailable-on-plan"` in `.github/settings.local.json`; both commands then skip rulesets and plan-gated repository settings (`allow_auto_merge`, which needs branch protection the plan lacks — GitHub answers a PATCH for it with HTTP 200 and silently keeps it off), converge the remaining merge settings, and print an unprotected-branch notice on every run. Never declare the opt-out to silence ruleset drift on a plan that can enforce — it documents a platform limitation, not a preference.

## Testing a canonical change before publishing

github/URL sources clone `main` unless `--ref` pins a tag, branch, or full commit sha — but any ref must exist on the remote, so the only way to try an *unpushed* change is a **local-path `--from`**: point a consumer at your local standards clone with uncommitted edits.

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
bun standards sync                                            # real sync from main → commit files + lock
```
