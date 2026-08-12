import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  runProcess,
  write,
} from './cli-test-support';

const COMPATIBILITY_SCRIPT = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/actionlint-queue-compat.bash',
);
const QUEUE_MESSAGE =
  'unexpected key "queue" for "concurrency" section. expected one of "cancel-in-progress", "group"';
const WORKFLOW_PATH = '.github/workflows/test.yml';
const EXECUTABLE_MODE = 0o755;
const FAKE_JSON_ENV = 'FAKE_ACTIONLINT_JSON';
const FAKE_NATIVE_OUTPUT_ENV = 'FAKE_ACTIONLINT_NATIVE_OUTPUT';
const FAKE_PROBE_STATUS_ENV = 'FAKE_ACTIONLINT_PROBE_STATUS';
const GITHUB_WORKSPACE_ENV = 'GITHUB_WORKSPACE';
const FAKE_ACTIONLINT = `#!/usr/bin/env bash
set -u
if [[ " $* " == *" -format "* ]]; then
  printf '%s\n' "$FAKE_ACTIONLINT_JSON"
  exit "\${FAKE_ACTIONLINT_STATUS:-1}"
fi
if [[ " $* " == *"actionlint-queue-compat."* ]]; then
  exit "\${FAKE_ACTIONLINT_PROBE_STATUS:-0}"
fi
printf '%s\n' "\${FAKE_ACTIONLINT_NATIVE_OUTPUT:-native Actionlint diagnostic}" >&2
exit "\${FAKE_ACTIONLINT_NATIVE_STATUS:-1}"
`;

type Diagnostic = {
  readonly message: string;
  readonly filepath: string;
  readonly line: number;
  readonly column: number;
  readonly kind: string;
};

afterEach(cleanupTmpDirs);

const queueDiagnostic = (
  lines: ReadonlyArray<string>,
  overrides: Partial<Diagnostic> = {},
): Diagnostic => {
  const line = lines.findIndex((entry) => entry.includes('queue:')) + 1;
  const source = lines[line - 1] ?? '';
  return {
    message: QUEUE_MESSAGE,
    filepath: WORKFLOW_PATH,
    line,
    column: source.length - source.trimStart().length + 1,
    kind: 'syntax-check',
    ...overrides,
  };
};

const runCompatibility = (
  concurrencyLines: ReadonlyArray<string>,
  diagnostics?: ReadonlyArray<Diagnostic>,
  probeStatus = 0,
) => {
  const fixture = mkTmp('actionlint-queue-compat-');
  const workflowLines = [
    'name: Test',
    'on: push',
    ...concurrencyLines,
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo ok',
    '',
  ];
  write(fixture, WORKFLOW_PATH, workflowLines.join('\n'));
  write(fixture, 'fake-actionlint.bash', FAKE_ACTIONLINT);
  const fakeActionlint = join(fixture, 'fake-actionlint.bash');
  chmodSync(fakeActionlint, EXECUTABLE_MODE);

  return runProcess('bash', fixture, [COMPATIBILITY_SCRIPT, fakeActionlint], {
    ...process.env,
    [FAKE_JSON_ENV]: JSON.stringify(
      diagnostics ?? [queueDiagnostic(workflowLines)],
    ),
    [FAKE_NATIVE_OUTPUT_ENV]: 'ordinary diagnostic retained',
    [FAKE_PROBE_STATUS_ENV]: String(probeStatus),
    [GITHUB_WORKSPACE_ENV]: fixture,
  });
};

describe('Actionlint concurrency queue compatibility', () => {
  it.each([
    ['without cancellation', ['concurrency:', '  group: test', '  queue: max']],
    [
      'with literal false cancellation',
      [
        'concurrency:',
        '  group: test',
        '  cancel-in-progress: false',
        '  queue: max',
      ],
    ],
  ])('accepts queue: max %s', (_name, lines) => {
    expect(runCompatibility(lines).status).toBe(0);
  });

  it.each([
    [
      'an arbitrary value',
      ['concurrency:', '  group: test', '  queue: banana'],
    ],
    ['queue: single', ['concurrency:', '  group: test', '  queue: single']],
    [
      'conflicting cancellation',
      [
        'concurrency:',
        '  group: test',
        '  cancel-in-progress: true',
        '  queue: max',
      ],
    ],
    [
      'expression cancellation',
      [
        'concurrency:',
        '  group: test',
        `  cancel-in-progress: \${{ github.event_name == 'pull_request' }}`,
        '  queue: max',
      ],
    ],
    [
      'quoted conflicting cancellation',
      [
        'concurrency:',
        '  group: test',
        '  "cancel-in-progress": true',
        '  queue: max',
      ],
    ],
    [
      'a structural mismatch',
      ['not-concurrency:', '  group: test', '  queue: max'],
    ],
    [
      'an escaped semantic cancellation key',
      [
        'concurrency:',
        '  group: test',
        '  "cancel\\u002din\\u002dprogress": true',
        '  queue: max',
      ],
    ],
    [
      'an explicit semantic cancellation key',
      [
        'concurrency:',
        '  group: test',
        '  ? cancel-in-progress',
        '  : true',
        '  queue: max',
      ],
    ],
  ])('rejects %s', (name, lines) => {
    const semanticConflict =
      name.includes('cancellation') || name.includes('semantic');
    const result = runCompatibility(lines, undefined, semanticConflict ? 1 : 0);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ordinary diagnostic retained');
  });

  it('preserves every ordinary Actionlint diagnostic', () => {
    const lines = ['concurrency:', '  group: test', '  queue: max'];
    const fixtureLines = ['name: Test', 'on: push', ...lines];
    const ordinary: Diagnostic = {
      message: 'property "missing" is not defined',
      filepath: WORKFLOW_PATH,
      line: 2,
      column: 1,
      kind: 'expression',
    };
    const result = runCompatibility(lines, [
      queueDiagnostic(fixtureLines),
      ordinary,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ordinary diagnostic retained');
  });
});
