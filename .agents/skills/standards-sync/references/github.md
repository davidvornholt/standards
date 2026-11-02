# GitHub settings, automatic sync, and auto-merge

## Repository settings

Repository settings, rulesets, and labels are declared in `.github/settings.json` and the project's `.github/settings.local.json`. Change the declarations, never the GitHub UI: the required `check` job compares the live repository with them and fails on drift.

```sh
bun standards github --apply   # converge the live repository; needs admin authentication
bun standards github --check   # compare the live repository with the declarations
```

Run `--apply` from the branch that changes the declarations, before it merges. That pull request's own `check` already compares the live repository with the new declarations.

CI checks with its restricted workflow token, which can't see who may bypass a ruleset. It can verify a declared-empty bypass list, but fails on a non-empty one, so verify a non-empty list with a local, admin-authenticated `--check`. Declare `{"rulesetEnforcement":"unavailable-on-plan"}` only when the repository's plan can't enforce rulesets.

## Automatic sync

Unless `sync-standards.local.json` sets `"autoSync": false`, a weekly run keeps one sync pull request open from the branch `standards-sync/update` while canonical content differs. Each run rebases that branch and updates it, so commits you add to adapt the consumer survive. The pull request description doesn't: every run that changes the branch rewrites it.

When no open pull request uses the branch, the run rebuilds the branch from the base branch instead of rebasing the old one. The workflow owns the `standards-sync/` branch namespace. It closes every other open same-repository pull request there, and closes all of them once the base branch already matches upstream.

Sync branches contain trusted upstream code, so consumer CI may run on them before anyone reviews the generated pull request.

The workflow mints three short-lived tokens for the current repository from the broker GitHub App in `ci.broker_app` of the SOPS-encrypted CI secrets. One pushes the branch and needs contents and workflows permissions, because synced files include workflows. Another opens or updates the sync pull request and closes superseded ones. The third turns on auto-merge for the sync pull request; see [Auto-merge](#auto-merge). No token reaches the sync process, and there is no fallback credential. To provision the App, install the repository owner's private broker App on this repository only, then run:

```sh
bun standards creds add github --dest ci:ci.broker_app
```

Standards auto-merge uses the same App, so a repository with `"autoSync": false` still needs it.

## Auto-merge

The `Standards auto-merge` workflow lets bot pull requests merge themselves once the required `check` passes, without review:

- Dependabot minor and patch version updates on this repository's own branches. Major updates stay manual, and so do updates without a semantic version, such as Nix flake inputs, and groups that contain a major update. Dependabot holds each version update until its release is three days old. Security updates skip that hold.
- The sync pull request. Every sync run that changes the branch makes sure auto-merge is on.

Both turn auto-merge on with a merge token from the broker App with Contents write, Pull requests write, and Workflows write. A merge the App enables starts the push workflows on main; one enabled with the workflow token would not. Workflows write lets it merge pull requests that change workflows.

The ruleset only merges a branch that is up to date with main, and Dependabot doesn't rebase a pull request that is merely behind. After each push to main, the workflow therefore merges main into every bot pull request that the App set to auto-merge and whose checks haven't failed, which runs `check` again. The merge commit message carries `[dependabot skip]`, so Dependabot still rebases the pull request later. The next sync run rebuilds the sync branch over such a merge. The workflow doesn't update a pull request whose checks failed. After a passing rerun, update it from the pull request page or wait for the next push to main. A pull request that conflicts with main waits for Dependabot or the next sync run to resolve it.

When a person pushes to a Dependabot branch, the workflow turns auto-merge off if the App turned it on, and the pull request stays manual. To hold any bot pull request, turn its auto-merge off.

In a public repository without an Actions event policy, GitHub's default policy blocks `pull_request_target`, which the Dependabot job runs on. It only reports affected runs until December 2, 2026, and blocks them after that. Allow `pull_request_target` for the workflow path `.github/workflows/standards-auto-merge.yml` in an Actions event policy. If the policy also restricts actors, allow `dependabot[bot]`. The workflow never checks out pull request code: it reads the update metadata through the API and runs only files from main.

## Environment-scoped bootstrap key

The sync job and the auto-merge jobs that mint tokens read their SOPS key, `SOPS_AGE_KEY`, from the GitHub Environment named by the Actions variable `CI_SECRETS_ENVIRONMENT`. When that key is scoped to an environment, set the variable to that environment's name at repository or organization scope, for example with `gh variable set CI_SECRETS_ENVIRONMENT --body production`. An environment-level variable comes too late, because GitHub resolves the job's environment before the job starts. The environment's protection rules still apply. When the key is a repository secret, leave the variable unset, and the jobs select no environment.

Fix a missing environment selection through the variable, not by copying the key into repository secrets.
