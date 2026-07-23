import { expect, it } from 'bun:test';
import process from 'node:process';
import { ACTUAL_UPSTREAM, runProcess } from './cli-test-support';
import {
  contract,
  DIGEST_A,
  DIGEST_B,
  DIGEST_C,
  environment,
} from './image-promotion-reference-contract-test-support';

type DetectorFixture = {
  readonly expectedStatus: number;
  readonly expectedWindows: number;
  readonly values: Readonly<Record<string, string | undefined>>;
};

const detectorPrelude = `
read-desired-digest() {
  printenv "DESIRED_$1_$2"
}
resolve-tracked-tag() {
  printenv "OBSERVED_$1_$2"
}
wait-promotion-window() {
  printf 'wait:%s\\n' "$1"
}
commit() { printf 'WRITE:commit\\n' >&2; }
dispatch() { printf 'WRITE:dispatch\\n' >&2; }
open-pr() { printf 'WRITE:open-pr\\n' >&2; }
`;

const runDetector = (fixture: DetectorFixture) => {
  const result = runProcess(
    'bash',
    ACTUAL_UPSTREAM,
    [
      '-c',
      `set -euo pipefail\n${detectorPrelude}\n${contract('drift-detector', 'sh')}`,
    ],
    environment([
      ['PATH', process.env.PATH],
      ...Object.entries(fixture.values),
    ]),
  );
  const calls = result.stdout.trim().split('\n').filter(Boolean);
  return {
    result,
    waits: calls.filter((line) => line.startsWith('wait:')),
    writes: calls.filter((line) => line.startsWith('WRITE:')),
  };
};

const fixtures: Readonly<Record<string, DetectorFixture>> = {
  healthy: {
    expectedStatus: 0,
    expectedWindows: 0,
    values: environment([
      ['DESIRED_0_initial', DIGEST_A],
      ['OBSERVED_0_initial', DIGEST_A],
    ]),
  },
  fresh: {
    expectedStatus: 0,
    expectedWindows: 1,
    values: environment([
      ['DESIRED_0_current', DIGEST_B],
      ['DESIRED_0_initial', DIGEST_A],
      ['DESIRED_1_initial', DIGEST_B],
      ['OBSERVED_0_current', DIGEST_B],
      ['OBSERVED_0_initial', DIGEST_B],
      ['OBSERVED_1_initial', DIGEST_B],
    ]),
  },
  overdue: {
    expectedStatus: 1,
    expectedWindows: 1,
    values: environment([
      ['DESIRED_0_current', DIGEST_A],
      ['DESIRED_0_initial', DIGEST_A],
      ['OBSERVED_0_current', DIGEST_B],
      ['OBSERVED_0_initial', DIGEST_B],
    ]),
  },
  'tag B to C': {
    expectedStatus: 0,
    expectedWindows: 2,
    values: environment([
      ['DESIRED_0_current', DIGEST_A],
      ['DESIRED_0_initial', DIGEST_A],
      ['DESIRED_1_current', DIGEST_C],
      ['DESIRED_1_initial', DIGEST_A],
      ['DESIRED_2_initial', DIGEST_C],
      ['OBSERVED_0_current', DIGEST_C],
      ['OBSERVED_0_initial', DIGEST_B],
      ['OBSERVED_1_current', DIGEST_C],
      ['OBSERVED_1_initial', DIGEST_C],
      ['OBSERVED_2_initial', DIGEST_C],
    ]),
  },
  'desired and tag restart separately': {
    expectedStatus: 0,
    expectedWindows: 2,
    values: environment([
      ['DESIRED_0_current', DIGEST_C],
      ['DESIRED_0_initial', DIGEST_A],
      ['DESIRED_1_current', DIGEST_C],
      ['DESIRED_1_initial', DIGEST_C],
      ['DESIRED_2_initial', DIGEST_C],
      ['OBSERVED_0_current', DIGEST_B],
      ['OBSERVED_0_initial', DIGEST_B],
      ['OBSERVED_1_current', DIGEST_C],
      ['OBSERVED_1_initial', DIGEST_B],
      ['OBSERVED_2_initial', DIGEST_C],
    ]),
  },
};

it('executes healthy, fresh, overdue, B-to-C, and restart windows', () => {
  for (const [name, fixture] of Object.entries(fixtures)) {
    const { result, waits, writes } = runDetector(fixture);
    expect(result.status, name).toBe(fixture.expectedStatus);
    expect(waits, name).toHaveLength(fixture.expectedWindows);
    expect(writes, name).toEqual([]);
  }
});

it('observes both values and exposes no writer command', () => {
  const detector = contract('drift-detector', 'sh');
  expect(detector).toContain('initial_desired=');
  expect(detector).toContain('initial_observed=');
  expect(detector).toContain('current_desired=');
  expect(detector).toContain('current_observed=');
  for (const command of ['commit', 'dispatch', 'open-pr', 'gh ', 'git ']) {
    expect(detector).not.toContain(command);
  }
});
