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

The workflow pushes the branch, manages the sync pull request, and turns on its auto-merge with short-lived tokens for the current repository from the broker GitHub App in `ci.broker_app` of the SOPS-encrypted CI secrets. The App needs Contents, Pull requests, and Workflows write, because synced files include workflows. No token reaches the sync process, and there is no fallback credential. To provision the App, install the repository owner's private broker App on this repository only, then run:

```sh
bun standards creds add github --dest ci:ci.broker_app
```

Standards auto-merge uses the same App, so a repository with `"autoSync": false` still needs it.

## Auto-merge

The `Standards auto-merge` workflow lets bot pull requests merge themselves once the required `check` passes, without review:

- Dependabot minor and patch version updates on this repository's own branches. Major updates stay manual, and so do updates without a semantic version, such as Nix flake inputs, and groups that contain a major update. Dependabot holds each version update until its release is three days old. Security updates skip that hold.
- The sync pull request. The sync run that opens it turns its auto-merge on.

Auto-merge starts only where the repository allows auto-merge and an active rule on the base branch requires `check`. Without such a rule, gh would merge the pull request at once instead of waiting for `check`. So in a repository that declares `"rulesetEnforcement": "unavailable-on-plan"`, bot pull requests stay manual.

Both turn auto-merge on with a merge token from the broker App with Contents write, Pull requests write, and Workflows write. A merge the App enables starts the push workflows on main; one enabled with the workflow token would not. Workflows write lets it merge pull requests that change workflows.

The ruleset only merges a branch that is up to date with main, and Dependabot doesn't rebase a pull request that is merely behind. After each push to main, the workflow therefore merges main into every bot pull request that the App set to auto-merge and whose checks haven't failed, which runs `check` again. When the App turns on auto-merge later, the workflow does the same for that pull request. The merge commit message carries `[dependabot skip]`, so Dependabot still rebases the pull request later. The next sync run rebuilds the sync branch over such a merge. The workflow doesn't update a pull request whose checks failed. After a passing rerun, wait for the next push to main, or comment `@dependabot rebase` on a Dependabot pull request. Updating the branch from the pull request page adds a commit from you. A pull request that conflicts with main waits for Dependabot or the next sync run to resolve it.

A Dependabot pull request may contain only commits that GitHub committed and signed with Dependabot as author, and the App's merges from main. The sync pull request may contain only the sync workflow's commits and the App's merges from main. Any other commit turns off the auto-merge the App turned on. Once auto-merge on a bot pull request has been turned off, by a person, by GitHub, or by the workflow, including when the pull request is closed, the App doesn't turn it on again: a person merges the pull request or turns auto-merge back on.

In a public repository without an Actions event policy, GitHub's default policy blocks `pull_request_target`, which the workflow's pull request jobs run on. It only reports affected runs until December 2, 2026, and blocks them after that. Allow `pull_request_target` for the workflow path `.github/workflows/standards-auto-merge.yml` in an Actions event policy. If the policy also restricts actors, allow `dependabot[bot]`, the broker App, and everyone who can push to the repository. A blocked run can't turn auto-merge off after someone else's push. The workflow never checks out pull request code: it reads the update metadata through the API and runs only files from main.

## Environment-scoped bootstrap key

The sync job and the auto-merge jobs that mint tokens read their SOPS key, `SOPS_AGE_KEY`, from the GitHub Environment named by the Actions variable `CI_SECRETS_ENVIRONMENT`. When that key is scoped to an environment, set the variable to that environment's name at repository or organization scope, for example with `gh variable set CI_SECRETS_ENVIRONMENT --body production`. An environment-level variable comes too late, because GitHub resolves the job's environment before the job starts. The environment's protection rules still apply. When the key is a repository secret, leave the variable unset, and the jobs select no environment.

Fix a missing environment selection through the variable, not by copying the key into repository secrets.
