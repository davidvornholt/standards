# GitHub settings and automatic sync

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

The workflow mints two short-lived tokens for the current repository from the broker GitHub App in `ci.broker_app` of the SOPS-encrypted CI secrets. One pushes the branch and needs contents and workflows permissions, because synced files include workflows. The other opens or updates the sync pull request and closes superseded ones. Neither token reaches the sync process, and there is no fallback credential. To provision the App, install the repository owner's private broker App on this repository only, then run:

```sh
bun standards creds add github --dest ci:ci.broker_app
```

A repository with `"autoSync": false` doesn't need the App until automatic sync is turned back on.

## Environment-scoped bootstrap key

The sync job reads its SOPS key, `SOPS_AGE_KEY`, from the GitHub Environment named by the Actions variable `CI_SECRETS_ENVIRONMENT`. When that key is scoped to an environment, set the variable to that environment's name at repository or organization scope, for example with `gh variable set CI_SECRETS_ENVIRONMENT --body production`. An environment-level variable comes too late, because GitHub resolves the job's environment before the job starts. The environment's protection rules still apply. When the key is a repository secret, leave the variable unset, and the job selects no environment.

Fix a missing environment selection through the variable, not by copying the key into repository secrets.
