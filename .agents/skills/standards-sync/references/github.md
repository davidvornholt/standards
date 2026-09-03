# GitHub settings and automatic sync

## Repository settings

Change declarations, never the GitHub UI:

```sh
bun standards github --apply
bun standards github --check
```

`--apply` needs admin authentication. Run it from a declaration-changing branch before merge. CI uses a restricted workflow token and fails when it cannot verify declared state. A non-empty ruleset bypass list therefore requires a local admin-authenticated check. `{"rulesetEnforcement":"unavailable-on-plan"}` is allowed only when the repository plan cannot enforce rulesets.

## Automatic sync

Repositories tracking `main` receive weekly pull requests when canonical content changes. The workflow reads `ci.broker_app` from SOPS. After installing the repository owner's private broker App only on the selected repository, provision it with:

```sh
bun standards creds add github --dest ci:ci.broker_app
```

The workflow mints two short-lived tokens for the current repository: a branch writer for contents and workflows, and a pull-request opener. Neither token enters the sync process, and there is no fallback credential. A repository with `autoSync: false` does not need these permissions until automatic sync is re-enabled.
