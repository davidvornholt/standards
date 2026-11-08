#!/usr/bin/env bash
set -euo pipefail

# The flake's packages and checks, the CLI's advertised platforms, and the CI
# matrix must all follow the systems nix/bun-archives.json pins for the root
# packageManager's Bun.
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT

(
  cd "$repo_root"
  git ls-files -z | tar --null -T - -cf -
) | tar -xf - -C "$fixture"

archives="$fixture/nix/bun-archives.json"
manifest="$fixture/package.json"
matrix_filter="$fixture/nix/bun-system-matrix.jq"
bun_version=$(jq -er '.packageManager | ltrimstr("bun@")' "$manifest")

assert_equal() {
  local label=$1
  local expected=$2
  local actual=$3
  if [[ "$actual" != "$expected" ]]; then
    printf '%s diverged:\nexpected: %s\nactual:   %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

update_archives() {
  jq --arg version "$bun_version" "$1" "$archives" >"$archives.update"
  mv "$archives.update" "$archives"
}

pinned_systems() {
  jq -cS --arg version "$bun_version" '.[$version] | keys' "$archives"
}

assert_flake_alignment() {
  local expected
  expected=$(pinned_systems)
  assert_equal "package systems" "$expected" "$(nix eval --json "$fixture#packages" --apply builtins.attrNames | jq -cS .)"
  assert_equal "check systems" "$expected" "$(nix eval --json "$fixture#checks" --apply builtins.attrNames | jq -cS .)"
  assert_equal "advertised platforms" "$expected" "$(nix eval --json "$fixture#packages.x86_64-linux.standards-cli.meta.platforms" | jq -cS .)"
}

assert_matrix_alignment() {
  assert_equal "native matrix systems" "$(pinned_systems)" \
    "$(jq -cS --slurpfile manifest "$manifest" -f "$matrix_filter" "$archives" | jq -cS '[.include[].system]')"
}

assert_flake_alignment
assert_matrix_alignment

# A newly pinned system joins every flake output, and CI refuses it until a
# native runner builds its checks.
update_archives '.[$version]["fixture-linux"] = .[$version]["x86_64-linux"]'
assert_flake_alignment
if jq -e --slurpfile manifest "$manifest" -f "$matrix_filter" "$archives" >/dev/null 2>&1; then
  echo 'The CI matrix accepted a system without a native runner' >&2
  exit 1
fi

update_archives 'del(.[$version]["aarch64-linux"], .[$version]["fixture-linux"])'
assert_flake_alignment
assert_matrix_alignment
echo 'Flake outputs and the CI matrix follow the pinned Bun systems.'
