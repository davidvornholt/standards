// Runs a step of the canonical standards workflow against a stubbed `gh api`
// that serves one JSON fixture per endpoint. Callers compose the step's full
// environment, so this module stays free of ambient process access.

import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTUAL_UPSTREAM,
  mkTmp,
  runProcess,
  write,
  yamlRunScript,
} from './cli-test-support';

export const WORKFLOW = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/standards.yml',
);

export type Json =
  | boolean
  | number
  | string
  | null
  | Array<Json>
  | { [key: string]: Json };

const EXECUTABLE_MODE = 0o755;
const SNAKE_BOUNDARY = /[A-Z]/gu;
const ENDPOINT_SEPARATOR = /[^A-Za-z0-9]/gu;

// Fixtures are written in camelCase and served in GitHub's snake_case.
const snakeCase = (value: Json): Json => {
  if (Array.isArray(value)) {
    return value.map(snakeCase);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.replace(SNAKE_BOUNDARY, (letter) => `_${letter.toLowerCase()}`),
        snakeCase(entry),
      ]),
    );
  }
  return value;
};

// Any flag fails the stub, so steps must parse responses with jq themselves.
const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = api ] || exit 2
shift
endpoint=
for argument in "$@"; do
  case "$argument" in
    -*) echo "unexpected gh flag $argument" >&2; exit 2 ;;
    *) endpoint=$argument ;;
  esac
done
file="$FIXTURE/api/$(printf '%s' "$endpoint" | tr -c 'A-Za-z0-9' '_').json"
[ -f "$file" ] || { echo "HTTP 404: $endpoint" >&2; exit 1; }
cat "$file"
`;

export type StepResult = {
  // What the step wrote to GITHUB_OUTPUT.
  readonly output: string;
  readonly status: number;
};

// An endpoint missing from `api` answers with a 404 error. The stub comes
// first on the `PATH` that `env` sets.
export const runStepWithApi = (
  stepName: string,
  api: Readonly<Record<string, Json>>,
  env: Readonly<Record<string, string | undefined>>,
): StepResult => {
  const fixture = mkTmp('standards-workflow-step-');
  for (const [endpoint, body] of Object.entries(api)) {
    write(
      fixture,
      `api/${endpoint.replace(ENDPOINT_SEPARATOR, '_')}.json`,
      JSON.stringify(snakeCase(body)),
    );
  }
  write(fixture, 'bin/gh', GH_STUB);
  chmodSync(join(fixture, 'bin/gh'), EXECUTABLE_MODE);
  const outputPath = join(fixture, 'output');
  const result = runProcess(
    'bash',
    fixture,
    ['-euo', 'pipefail', '-c', yamlRunScript(WORKFLOW, stepName)],
    {
      ...env,
      ...Object.fromEntries([
        ['FIXTURE', fixture],
        ['GITHUB_OUTPUT', outputPath],
        ['PATH', `${join(fixture, 'bin')}:${env.PATH ?? ''}`],
      ]),
    },
  );
  return {
    output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
    status: result.status,
  };
};
