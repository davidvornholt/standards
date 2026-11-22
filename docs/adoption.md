# Adopt the standards

Run `init` once per repository. Later updates use `bun standards sync`, or `bash .agents/skills/standards-sync/scripts/standards.sh sync` in a core repository, or the weekly sync pull request.

## What each part needs

- With `"autoSync": false`, either payload runs `init`, `sync`, and `check` locally without secrets, a broker GitHub App, or a GitHub repository. Once the repository has an `origin` remote, `check` compares its live GitHub settings.
- With `"autoSync": false`, a repository may go without `secrets/ci.yaml`, and its Dependabot pull requests then stay manual. Otherwise, and whenever `secrets/ci.yaml` exists, `check` on either payload requires that encrypted file to hold a broker GitHub App and `secrets/ci.example.yaml` to mirror its keys with placeholders.
- The weekly sync pull request and auto-merge need a GitHub repository, a CI age key in the `SOPS_AGE_KEY` Actions secret, and a private broker GitHub App owned by the repository's owner. A private App can be installed only on the account that owns it, so outside David's accounts, create your own after `init` with `bun standards creds login github --name <name>`, or `bash .agents/skills/standards-sync/scripts/standards.sh creds login github --name <name>` in a core repository (add `--org <org>` for an organization). GitHub App names are unique across GitHub and the default, `standards-broker`, is taken, so pass a name of your own.
- Everything else that refers to infrastructure, such as CodeBuild runners, Cloudflare credentials, and the screenshot bucket, is used only after you configure it. Without `CI_CODEBUILD_PROJECT`, the workflows run on `ubuntu-latest`.

Synced files follow `main` of davidvornholt/standards, which changes often. To pin them, set `"ref"` in `sync-standards.local.json` to a tag, branch, or commit, such as the release tag `"v0.39.1"`, and raise it when you want an update.

## New repository

```sh
bunx @davidvornholt/standards init
bun install
```

Then [connect CI and GitHub](#connect-ci-and-github).

## Repository outside Bun

A repository that isn't a Bun workspace, such as a Rust, Nix, or Python project, takes the core payload: `AGENTS.md`, the language-neutral skills, the weekly sync, and the CI workflow and GitHub settings that gate its pull requests. First move the project-specific content of `AGENTS.md` and `CLAUDE.md` below a `## Project-specific rules` heading at the end of `AGENTS.md`, and delete `CLAUDE.md`. Then run the CLI with `bunx`, which needs Bun installed but not a Bun workspace:

```sh
echo '{ "payload": "core" }' > sync-standards.local.json
bunx @davidvornholt/standards init
```

Commit `sync-standards.lock`, `sync-standards.local.json`, and the seeded `.github/settings.local.json` and `secrets/ci.example.yaml`. From then on, run the CLI as `bash .agents/skills/standards-sync/scripts/standards.sh`, which runs the commit `sync-standards.lock` records, as the Standards workflow does. Require the repository's own CI checks in `.github/settings.local.json` rulesets, then, with admin-authenticated `gh`, run `bash .agents/skills/standards-sync/scripts/standards.sh github --apply`. The canonical settings protect the default branch, so every change lands through a pull request that passes `check`.

For the weekly sync pull request, the repository needs a CI age key and an encrypted `secrets/ci.yaml`. The core payload ships no `justfile` or secrets recipes, so create them with `age`, `sops`, and `gh` signed in with admin access to the repository, which `gh secret set` needs:

```sh
export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt
mkdir -p ~/.config/sops/age
[ -f "$SOPS_AGE_KEY_FILE" ] || age-keygen -o "$SOPS_AGE_KEY_FILE"
(
set -eu
[ ! -e .sops.yaml ] && [ ! -e secrets/ci.yaml ] || { echo '.sops.yaml or secrets/ci.yaml already exists' >&2; exit 1; }
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
age-keygen -o "$d/ci.key"
grep AGE-SECRET-KEY "$d/ci.key" | gh secret set SOPS_AGE_KEY
mkdir -p secrets
cat > .sops.yaml <<EOF
creation_rules:
  - path_regex: secrets/ci\.yaml$
    key_groups:
      - age:
          - &personal $(age-keygen -y "$SOPS_AGE_KEY_FILE")
          # GitHub Actions CI recipient (private key: SOPS_AGE_KEY Actions secret).
          - &ci $(age-keygen -y "$d/ci.key")
EOF
printf 'ci: {}\n' | sops encrypt --filename-override secrets/ci.yaml --output secrets/ci.yaml /dev/stdin
)
```

`SOPS_AGE_KEY_FILE` tells `sops` where the personal key is, because on macOS it looks elsewhere by default. Export it again in each later shell that runs `sops` or `creds`. The block stops without changing anything when `.sops.yaml` or `secrets/ci.yaml` already exists. In that case, create a key as the block does, add its public key to the existing `secrets/ci.yaml` rule, run `sops updatekeys secrets/ci.yaml`, and pipe the new private key into `gh secret set SOPS_AGE_KEY`.

Rename `&personal` to identify the person and machine, as [Secrets bootstrap](../.agents/skills/declarative-infra/references/secrets.md#identities-and-recipients) describes, and commit `.sops.yaml` and `secrets/ci.yaml`. Then do step 2 of [Connect CI and GitHub](#connect-ci-and-github), running `bash .agents/skills/standards-sync/scripts/standards.sh` in place of `bun standards`, and run `bash .agents/skills/standards-sync/scripts/standards.sh check`.

## Existing repository

`init` keeps project-owned files, but it replaces synced files and regenerates generated files without asking. Move project-specific content out of synced paths first:

| Existing path | Move its project-specific content to |
| --- | --- |
| `AGENTS.md`, `CLAUDE.md` | Below a `## Project-specific rules` heading at the end of `AGENTS.md`, then delete `CLAUDE.md` |
| `justfile`, `secrets.just` | `local.just` |
| `.github/dependabot.yml` | Below a `# Project-specific updates` line, indented two spaces, at the end of `.github/dependabot.yml`, without the root `bun` and `github-actions` blocks |
| `.claude/skills/<name>` | `.agents/skills/<name>` |

```sh
bun add --dev --exact @davidvornholt/standards
bun standards init
```

Commit `sync-standards.lock`; it is the drift baseline. Then run `bun standards check` and fix what it reports. The files in [`template/`](../template) show the expected project-owned wiring, such as the root scripts and the `turbo.json` lint tasks.

Biome's `noUndeclaredEnvVars` rule requires every environment variable that code reads to be declared in `turbo.json`. Declare it in the `env` of each task whose output depends on it, so Turbo does not reuse a result cached with a different value. Declare the rest, such as settings that only a running server reads, in `passThroughEnv` on `//#lint`, which adds them to no cache key.

## Connect CI and GitHub

1. Create the repository's CI age key and its `SOPS_AGE_KEY` Actions secret as described in [Secrets bootstrap](../.agents/skills/declarative-infra/references/secrets.md).
2. Install the repository owner's broker GitHub App on the repository, after creating it as [What each part needs](#what-each-part-needs) describes if the owner has none, then provision it with `bun standards creds add github --dest ci:ci.broker_app`. Automatic sync and Standards auto-merge need it; see [GitHub settings, automatic sync, and auto-merge](../.agents/skills/standards-sync/references/github.md). In a public repository, also allow `pull_request_target` for `.github/workflows/standards-auto-merge.yml` in an Actions event policy, as that page describes.
3. With admin-authenticated `gh`, run `bun standards github --apply`, then `bun standards github --check`.
4. To pin the source, set `"ref"` as [What each part needs](#what-each-part-needs) describes. To turn off the weekly sync, set `"autoSync": false` in `sync-standards.local.json`.
5. Run `bun run check`.

## Windows

`.claude/skills` is a symlink to `../.agents/skills`. Set `core.symlinks=true` before cloning and enable Developer Mode or use an elevated shell, or work in WSL. A checkout that turns the link into a text file fails the drift check.
