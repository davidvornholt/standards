#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT

(
  cd "$repo_root"
  git ls-files -z | tar --null -T - -cf -
) | tar -xf - -C "$fixture"

metadata="$fixture/nix/bun-system-metadata.json"
matrix_filter="$fixture/nix/bun-system-matrix.jq"

assert_equal() {
  local label=$1
  local expected=$2
  local actual=$3
  if [[ "$actual" != "$expected" ]]; then
    printf '%s diverged:\nexpected: %s\nactual:   %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_alignment() {
  local metadata_systems
  local package_systems
  local check_systems
  local advertised_platforms
  local expected_matrix
  local actual_matrix

  metadata_systems=$(jq -cS 'keys' "$metadata")
  package_systems=$(nix eval --json "$fixture#packages" --apply builtins.attrNames | jq -cS .)
  check_systems=$(nix eval --json "$fixture#checks" --apply builtins.attrNames | jq -cS .)
  advertised_platforms=$(nix eval --json "$fixture#packages.x86_64-linux.standards-cli.meta.platforms" | jq -cS .)
  expected_matrix=$(jq -cS '{include: [to_entries[] | {runner: .value.runner, system: .key}] | sort_by(.system)}' "$metadata")
  actual_matrix=$(jq -cS -f "$matrix_filter" "$metadata")

  assert_equal "package systems" "$metadata_systems" "$package_systems"
  assert_equal "check systems" "$metadata_systems" "$check_systems"
  assert_equal "advertised platforms" "$metadata_systems" "$advertised_platforms"
  assert_equal "native matrix" "$expected_matrix" "$actual_matrix"
}

assert_alignment

metadata_update="$fixture/nix/bun-system-metadata.update.json"
jq '.["fixture-linux"] = {
  archiveHash: "sha256-lR7iruhV8IWVruxiJSJqKY0/6oOj3NZGXAnLzN9+hI8=",
  archivePlatform: "x64",
  runner: "ubuntu-24.04"
}' "$metadata" >"$metadata_update"
mv "$metadata_update" "$metadata"
assert_alignment

jq 'del(.["aarch64-linux"], .["fixture-linux"])' "$metadata" >"$metadata_update"
mv "$metadata_update" "$metadata"
assert_alignment
