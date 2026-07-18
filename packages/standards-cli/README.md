# @davidvornholt/standards

CLI for bootstrapping, synchronizing, and validating repositories that consume [davidvornholt/standards](https://github.com/davidvornholt/standards).

```sh
bunx @davidvornholt/standards init
standards sync
standards check
standards doctor
standards structure
standards github --check
standards github --apply
```

`github --check` compares the live GitHub repository (merge settings and rulesets) against the merged declaration in `.github/settings.json` + `.github/settings.local.json`; `github --apply` converges the live repository to exactly the declared state. `check` runs the same comparison whenever `.github/settings.json` is present, and fails closed: declared state the token cannot see fails the gate with a message naming the token fix instead of passing unverified. `--apply` re-diffs the PATCH response, so a setting GitHub accepts with HTTP 200 but silently ignores (plan-unavailable features) is a reported failure, not a false success. A repository whose GitHub plan cannot enforce rulesets can declare that in the seam (see `rulesetEnforcement` below); both commands then skip rulesets and plan-gated repository settings, converge the rest, and print an unprotected-branch notice on every run.

`structure` enforces the canonical monorepo structure contract: workspace scripts (`check-types`, `lint`, `lint:fix`, `test`), root gate scripts, filtered Turbo convenience aliases, internal `0.0.0`/`workspace:*` versioning, package `exports`, shared tsconfig inheritance, and browser a11y wiring. Only a workspace containing an explicit `*.a11y.ts` suite must provide a `test:a11y` script and direct `@axe-core/playwright` and `@playwright/test` dependencies. `check` includes `structure`, so these rules gate every consumer PR.

`structure --profile source` validates the standards source repository itself, which is deliberately not a consumer. The profile pins its intentional exceptions so they cannot drift silently: exact, ordered root gate scripts that run this CLI from the local checkout (`structure --profile source`, `github --check`, and the Turbo gate) instead of a recursive `standards check`, and a non-private published bin-only CLI workspace that carries a stable release SemVer and exactly maps the `standards` bin to `src/cli.ts` without `exports`. Every other consumer rule still applies.

## Configuration

- **`sync-standards.local.json`** (optional) — consumer-owned sync policy at the repo root, validated by `doctor`/`check` and every `init`/`sync` even when an explicit ref or local source makes its `"ref"` irrelevant. All fields optional; a missing file means the defaults. `"ref"` is a non-empty single-line string that pins a tag, branch, or full commit sha to sync from instead of `main` (an explicit `--ref` overrides it; a local-path `--from` source is used as-is and ignores only the validated pin). `"autoSync": false` is read by the standards-sync workflow, not the CLI, and skips the weekly scheduled run. Version 0.7.0 removes the legacy `STANDARDS_AUTO_SYNC` and `STANDARDS_SYNC_REF` variable behavior; consumers must upgrade the package and lockfile before adopting a policy file.
- **`.github/settings.local.json` `"rulesetEnforcement": "unavailable-on-plan"`** (optional) — declares that the repository's GitHub plan cannot enforce rulesets (private repositories on GitHub Free, both personal accounts and organizations). `github --check` and `--apply` then skip rulesets instead of comparing them, because a comparison cannot be trusted there: personal accounts answer ruleset reads with HTTP 403, and free-plan organizations report declared rulesets as active while silently not enforcing them. Plan-gated repository settings that only function alongside branch protection (`allow_auto_merge`) are skipped for the same reason — GitHub accepts a PATCH for them with HTTP 200 and silently keeps the old value. The remaining repository merge settings are still checked and converged, and both commands print an unprotected-branch notice on every run. The only accepted value is `"unavailable-on-plan"` (enforcement is the default; omit the key on paid plans), and combining the opt-out with additional local rulesets is rejected. After upgrading the plan, remove the declaration and run `bun standards github --apply` to restore enforcement.
- **`GH_TOKEN` / `GITHUB_TOKEN`** (optional) — GitHub API token for the `github` command and the GitHub portion of `check`. When neither is set, the token from the local `gh` CLI is used; with no token at all, reads still work on public repositories. `--apply` needs an admin token. GitHub's REST API reveals repo merge settings only to write-capable viewers — `check` retries REST-hidden keys over GraphQL, which serves them to read-only tokens — and ruleset `bypass_actors` requires repository Administration read; a token that still cannot see declared state fails the check rather than passing unverified. In CI, where the workflow token can never hold that permission, the canonical workflow decrypts `ci.github_settings_read_token` from the SOPS-encrypted `secrets/ci.yaml` — a fine-grained PAT with read-only "Administration" access to the repository.

See the standards repository README for the ownership model and adoption workflow.
