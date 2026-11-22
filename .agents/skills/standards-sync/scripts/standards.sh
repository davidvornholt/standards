#!/usr/bin/env bash
# Runs the standards CLI from the commit that sync-standards.lock records, the
# one the Standards workflow runs in a core consumer. Run it from the
# repository root:
#   bash .agents/skills/standards-sync/scripts/standards.sh <command> [options]
# Each commit is fetched and installed once into the user's cache.
set -euo pipefail

lock=sync-standards.lock
if [ ! -f "$lock" ]; then
  echo "standards.sh: run it from the repository root, where $lock is; before the first sync, run \`bunx @davidvornholt/standards init\`" >&2
  exit 1
fi
read_lock() {
  bun --no-env-file -e '
    const lock = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const value = lock?.[process.argv[2]];
    if (typeof value === "string") console.log(value);
  ' "$lock" "$1"
}
upstream=$(read_lock upstream)
rev=$(read_lock sha)
repository=${upstream#github:}
if [[ ! "$upstream" =~ ^github:[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$ ]] || [[ "$repository" == */. || "$repository" == */.. ]]; then
  echo "standards.sh: $lock must name a github:owner/repo upstream to fetch the standards CLI from" >&2
  exit 1
fi
if [[ ! "$rev" =~ ^[0-9a-f]{40}$ ]]; then
  echo "standards.sh: $lock must record the full commit its files were synced from" >&2
  exit 1
fi

cache="${XDG_CACHE_HOME:-$HOME/.cache}/davidvornholt-standards/cli"
source="$cache/${repository//\//-}-$rev"
if [ ! -f "$source/.installed" ]; then
  # A Git hook that runs this script passes its repository's GIT_DIR,
  # GIT_INDEX_FILE and the like, which would point the bootstrap's Git at the
  # consumer's repository. Configuration variables stay, so the user's Git
  # configuration still applies.
  (
    # A plain assignment, so set -e stops the bootstrap when Git can't list them.
    local_env_vars=$(git rev-parse --local-env-vars)
    for variable in $local_env_vars; do
      case "$variable" in
        GIT_CONFIG*) ;;
        *) unset "$variable" ;;
      esac
    done
    mkdir -p "$cache"
    staging=$(mktemp -d "$cache/.staging.XXXXXX")
    trap 'rm -rf -- "$staging"' EXIT
    git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
    git init --quiet "$staging"
    git -C "$staging" fetch --quiet --depth=1 --no-tags -- "https://github.com/$repository.git" "$rev"
    git -C "$staging" checkout --quiet --detach "$rev"
    (cd "$staging" && bun install --frozen-lockfile --filter @davidvornholt/standards --production --ignore-scripts >&2)
    touch "$staging/.installed"
    # A rename onto an installed copy fails, so a concurrent run that installed
    # the same commit first keeps its copy, and the trap removes this one.
    bun --no-env-file -e 'try { require("node:fs").renameSync(process.argv[1], process.argv[2]) } catch {}' "$staging" "$source"
  )
  if [ ! -f "$source/.installed" ]; then
    echo "standards.sh: could not install the standards CLI into $source" >&2
    exit 1
  fi
fi

exec bun --no-env-file "$source/packages/standards-cli/src/cli.ts" "$@"
