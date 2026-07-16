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

`github --check` compares the live GitHub repository (merge settings and rulesets) against the merged declaration in `.github/settings.json` + `.github/settings.local.json`; `github --apply` converges the live repository to exactly the declared state. `check` runs the same comparison whenever `.github/settings.json` is present.

`structure` enforces the canonical monorepo structure contract: workspace scripts (`check-types`, `lint`, `lint:fix`, `test`), root gate scripts, filtered Turbo convenience aliases, internal `0.0.0`/`workspace:*` versioning, package `exports`, shared tsconfig inheritance, and browser a11y wiring. Only a workspace containing an explicit `*.a11y.ts` suite must provide a `test:a11y` script and direct `@axe-core/playwright` and `@playwright/test` dependencies. `check` includes `structure`, so these rules gate every consumer PR.

## Configuration

- **`sync-standards.local.json`** (optional) — consumer-owned sync policy at the repo root, validated by `doctor`/`check` and every `init`/`sync` even when an explicit ref or local source makes its `"ref"` irrelevant. All fields optional; a missing file means the defaults. `"ref"` is a non-empty single-line string that pins a tag, branch, or full commit sha to sync from instead of `main` (an explicit `--ref` overrides it; a local-path `--from` source is used as-is and ignores only the validated pin). `"autoSync": false` is read by the standards-sync workflow, not the CLI, and skips the weekly scheduled run. Version 0.7.0 removes the legacy `STANDARDS_AUTO_SYNC` and `STANDARDS_SYNC_REF` variable behavior; consumers must upgrade the package and lockfile before adopting a policy file.
- **`GH_TOKEN` / `GITHUB_TOKEN`** (optional) — GitHub API token for the `github` command and the GitHub portion of `check`. When neither is set, the token from the local `gh` CLI is used; with no token at all, reads still work on public repositories. `--apply` and private-repo reads need an authenticated token, and repo merge settings are only visible (and thus verifiable) to admin tokens — non-admin runs report them as unverifiable.

See the standards repository README for the ownership model and adoption workflow.
