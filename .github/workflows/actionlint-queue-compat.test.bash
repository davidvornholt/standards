#!/usr/bin/env bash

set -euo pipefail

if (( $# != 1 )); then
  echo "usage: actionlint-queue-compat.test.bash <actionlint>" >&2
  exit 2
fi

actionlint=$(realpath -e -- "$1")
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
compatibility="$script_dir/actionlint-queue-compat.bash"
fixture_root=$(mktemp -d)
trap 'rm -rf -- "$fixture_root"' EXIT

run_case() {
  local name=$1 expected_status=$2 required=${3-} forbidden=${4-} workflow=$5
  local case_root="$fixture_root/$name" output status

  mkdir -p "$case_root/.github/workflows"
  git init --quiet "$case_root"
  printf '%s\n' "$workflow" >"$case_root/.github/workflows/test.yml"

  set +e
  output=$(cd "$case_root" && GITHUB_WORKSPACE="$case_root" RUNNER_TEMP="$fixture_root" bash "$compatibility" "$actionlint" 2>&1)
  status=$?
  set -e

  if (( status != expected_status )); then
    printf 'case %s: expected status %s, got %s\n%s\n' "$name" "$expected_status" "$status" "$output" >&2
    return 1
  fi
  if [[ -n "$required" && "$output" != *"$required"* ]]; then
    printf 'case %s: missing required output %s\n%s\n' "$name" "$required" "$output" >&2
    return 1
  fi
  if [[ -n "$forbidden" && "$output" == *"$forbidden"* ]]; then
    printf 'case %s: contained forbidden output %s\n%s\n' "$name" "$forbidden" "$output" >&2
    return 1
  fi
}

run_case multi-queue 0 '' '' $'name: Multiple queues\n\non: push\n\njobs:\n  first:\n    concurrency:\n      group: first\n      queue: max\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo first\n  second:\n    concurrency:\n      group: second\n      queue: max\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo second'

run_case unrelated-diagnostic 1 'property "missing" is not defined' 'queue: max requires cancel-in-progress' $'name: Unrelated diagnostic\n\non: push\n\nconcurrency:\n  group: unrelated\n  queue: max\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ runner.missing }}"'

run_case escaped-false 0 '' '' $'name: Escaped false\n\non: push\n\nconcurrency:\n  group: escaped-false\n  "cancel\\u002din\\u002dprogress": false\n  queue: max\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok'

run_case explicit-false 0 '' '' $'name: Explicit false\n\non: push\n\nconcurrency:\n  group: explicit-false\n  ? cancel-in-progress\n  : false\n  queue: max\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok'

run_case escaped-true 1 'queue: max requires cancel-in-progress to be absent or literal false' '' $'name: Escaped true\n\non: push\n\nconcurrency:\n  group: escaped-true\n  "cancel\\x2din\\x2dprogress": true\n  queue: max\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok'

run_case explicit-true 1 'queue: max requires cancel-in-progress to be absent or literal false' '' $'name: Explicit true\n\non: push\n\nconcurrency:\n  group: explicit-true\n  ? cancel-in-progress\n  : true\n  queue: max\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok'

run_case direct-true 1 'queue: max requires cancel-in-progress to be absent or literal false' '' $'name: Direct true\n\non: push\n\nconcurrency:\n  group: direct-true\n  cancel-in-progress: true\n  queue: max\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok'

run_case expression 1 'queue: max requires cancel-in-progress to be absent or literal false' '' $'name: Expression\n\non: push\n\nconcurrency:\n  group: expression\n  cancel-in-progress: ${{ github.event_name == \'pull_request\' }}\n  queue: max\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok'
