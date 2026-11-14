import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import {
  calls,
  check,
  createLand,
  type Land,
  land,
  mergeCall,
  mergeCalls,
} from './land-test-support';

// A test that waits out a short limit of WAIT_SECONDS expects land to stop
// within LIMIT_MS, which leaves room for the fake gh processes. On a machine
// under load, a poll can take a second.
const WAIT_SECONDS = 2;
const LIMIT_MS = 8000;
// A gh call that hangs far longer than the limit.
const HANG_MS = 20_000;
const SLOW_TEST_MS = 120_000;
const SLOW_POLL_MS = 300;

let fixture: Land;

beforeEach(() => {
  fixture = createLand(process.env);
  fixture.pr.state = 'OPEN';
});

afterEach(() => {
  cleanupTmpDirs();
});

const lint = check({ name: 'lint' });
const build = check({ name: 'build' });

const pollCount = (): number =>
  calls(fixture, 'pr', 'view').filter((call) =>
    call.some((arg) => arg.includes('statusCheckRollup')),
  ).length;

const timedLand = (): { result: ReturnType<typeof land>; ms: number } => {
  const start = performance.now();
  const result = land(fixture, ['123']);
  return { result, ms: performance.now() - start };
};

describe('standards land on a blocked pull request with required checks', () => {
  it.each([
    ['a ruleset', 'rulesetChecks'],
    ['classic branch protection', 'protectionChecks'],
  ] as const)('waits for a check that %s requires', (_source, field) => {
    // The required check's run waits in a concurrency group, so it reports
    // nothing until it starts.
    fixture.github[field] = ['build'];
    Object.assign(fixture.pr, {
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [lint],
      polls: [
        {},
        { mergeStateStatus: 'CLEAN', statusCheckRollup: [lint, build] },
      ],
    });
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Waiting for build on');
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
  });

  it('blames reviews once every required check passed', () => {
    fixture.github.rulesetChecks = ['lint'];
    fixture.github.protectionChecks = ['build'];
    Object.assign(fixture.pr, {
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [lint, build],
    });
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('although its checks passed');
    expect(pollCount()).toBe(1);
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it('names a required check that never reports', () => {
    fixture.env.LAND_WAIT_SECONDS = String(WAIT_SECONDS);
    fixture.github.rulesetChecks = ['build'];
    Object.assign(fixture.pr, {
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [lint],
    });
    const { result, ms } = timedLand();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `PR #123 wasn't ready to merge within ${WAIT_SECONDS} seconds: its base branch requires build, which didn't report on`,
    );
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(mergeCalls(fixture)).toEqual([]);
  });
});

describe('standards land on a blocked pull request without checks', () => {
  it('stops at once when no workflow checks the pull request', () => {
    fixture.github.workflows = false;
    Object.assign(fixture.pr, {
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [],
      polls: [{}, { state: 'CLOSED' }],
    });
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'GitHub blocks merging PR #123 for a reason other than checks',
    );
    expect(result.stderr).not.toContain('--no-wait');
    expect(pollCount()).toBe(1);
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it('waits for checks when a workflow checks the pull request', () => {
    Object.assign(fixture.pr, {
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [],
      polls: [{}, { state: 'CLOSED' }],
    });
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Waiting for checks on');
    expect(result.stderr).toContain('became CLOSED while land waited');
  });

  it(
    "doesn't suggest --no-wait, which refuses it, when no checks appear",
    () => {
      fixture.env.LAND_WAIT_SECONDS = String(WAIT_SECONDS);
      Object.assign(fixture.pr, {
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [],
      });
      const { result } = timedLand();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `No checks appeared on PR #123 within ${WAIT_SECONDS} seconds`,
      );
      expect(result.stderr).not.toContain('--no-wait');
    },
    SLOW_TEST_MS,
  );
});

describe("standards land's limit on the wait for checks", () => {
  it(
    'counts the time GitHub takes to answer',
    () => {
      fixture.env.LAND_WAIT_SECONDS = String(WAIT_SECONDS);
      Object.assign(fixture.pr, {
        statusCheckRollup: [],
        hangMs: SLOW_POLL_MS,
      });
      const { result, ms } = timedLand();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `No checks appeared on PR #123 within ${WAIT_SECONDS} seconds`,
      );
      expect(ms).toBeLessThan(LIMIT_MS);
    },
    SLOW_TEST_MS,
  );

  it(
    'stops a gh call that hangs past the limit',
    () => {
      fixture.env.LAND_WAIT_SECONDS = String(WAIT_SECONDS);
      Object.assign(fixture.pr, {
        statusCheckRollup: [],
        polls: [{}, { hangMs: HANG_MS }, { hangMs: 0 }],
      });
      const { result, ms } = timedLand();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `No checks appeared on PR #123 within ${WAIT_SECONDS} seconds`,
      );
      expect(ms).toBeLessThan(LIMIT_MS);
    },
    SLOW_TEST_MS,
  );
});
