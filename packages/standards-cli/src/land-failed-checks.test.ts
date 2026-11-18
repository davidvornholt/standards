import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import {
  branchExists,
  CI,
  check,
  createLand,
  type Land,
  land,
  mergeCall,
  mergeCalls,
  now,
  OLD_UPDATE,
} from './land-test-support';

let fixture: Land;

beforeEach(() => {
  fixture = createLand(process.env);
});

afterEach(() => {
  cleanupTmpDirs();
});

const openPr = (fields: Record<string, unknown> = {}): void => {
  Object.assign(fixture.pr, { state: 'OPEN', ...fields });
};

describe('standards land with failed checks', () => {
  it('does not merge over failed checks', () => {
    const cases: ReadonlyArray<
      readonly [ReadonlyArray<Record<string, string>>, ReadonlyArray<string>]
    > = [
      [[check({ name: 'lint', conclusion: 'FAILURE' })], []],
      [
        [
          check({ name: 'lint', conclusion: 'FAILURE' }),
          check({ status: 'QUEUED', conclusion: '' }),
        ],
        ['--no-wait'],
      ],
      [
        [
          check({ name: 'lint', conclusion: 'CANCELLED', run: 2 }),
          check({ run: 1 }),
        ],
        [],
      ],
      [
        // A newer run that skips the check doesn't replace its failure.
        [
          check({ name: 'lint', conclusion: 'FAILURE', run: 1 }),
          check({ name: 'lint', conclusion: 'SKIPPED', run: 2 }),
        ],
        [],
      ],
      [
        // Nor does a cancelled one, even when a third run skips it.
        [
          check({ name: 'lint', conclusion: 'FAILURE', run: 1 }),
          check({ name: 'lint', conclusion: 'CANCELLED', run: 2 }),
          check({ name: 'lint', conclusion: 'SKIPPED', run: 3 }),
        ],
        [],
      ],
    ];
    fixture.github.runFiles['3'] = CI;
    for (const [rollup, options] of cases) {
      openPr({ statusCheckRollup: rollup });
      const result = land(fixture, ['123', ...options]);
      expect(result.status, JSON.stringify(rollup)).toBe(1);
      expect(result.stderr).toContain('lint failed on');
      expect(mergeCalls(fixture)).toEqual([]);
      expect(branchExists(fixture)).toBe(true);
    }
  });

  it('ignores a failed check that a newer run reports again', () => {
    // A cancelled run still runs its aggregate job, which fails on the
    // cancelled gates, and the run that cancelled it passes.
    openPr({
      statusCheckRollup: [
        check({ name: 'quality', conclusion: 'CANCELLED', run: 1 }),
        check({ conclusion: 'FAILURE', run: 1 }),
        check({ name: 'quality', run: 2 }),
        check({ run: 2 }),
      ],
    });
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
  });

  it('waits for a newer run of a failed check', () => {
    const failed = check({ conclusion: 'FAILURE' });
    openPr({
      polls: [
        {
          statusCheckRollup: [
            failed,
            check({ status: 'IN_PROGRESS', conclusion: '', run: 2 }),
          ],
        },
        { statusCheckRollup: [failed, check({ run: 2 })] },
      ],
    });
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Waiting for check on');
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
  });
});

describe('standards land with a failed check and a newer run', () => {
  it("keeps a failure that another workflow file's run reports again", () => {
    // Two workflow files can share a name.
    fixture.github.runFiles['2'] = '.github/workflows/frontend.yml';
    openPr({
      statusCheckRollup: [
        check({ name: 'lint', conclusion: 'FAILURE', run: 1 }),
        check({ name: 'lint', run: 2 }),
      ],
    });
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lint failed on');
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it('keeps a failure from a rerun that started after the pass', () => {
    // Rerunning an older run keeps its run id, so only the start times tell
    // which result is newer.
    openPr({
      statusCheckRollup: [
        check({ conclusion: 'FAILURE', started: '2026-01-01T00:31:00Z' }),
        check({ run: 2, started: '2026-01-01T00:28:00Z' }),
      ],
    });
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('check failed on');
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it("keeps a pull_request failure that a push run's pass follows", () => {
    // A push run tests the head, not its merge with the base.
    fixture.github.runEvents['2'] = 'push';
    openPr({
      statusCheckRollup: [check({ conclusion: 'FAILURE' }), check({ run: 2 })],
    });
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('check failed on');
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it("keeps a failure whose runs' workflows can't be read", () => {
    fixture.github.runFiles = {};
    openPr({
      statusCheckRollup: [check({ conclusion: 'FAILURE' }), check({ run: 2 })],
    });
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('check failed on');
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it('waits for a newer run before it reports the check', () => {
    // A cancelled run's aggregate fails before the run that cancelled it
    // reports its own aggregate.
    const cancelled = [
      check({ name: 'quality', conclusion: 'CANCELLED', run: 1 }),
      check({ conclusion: 'FAILURE', run: 1 }),
    ];
    openPr({
      polls: [
        {
          statusCheckRollup: [
            ...cancelled,
            check({
              name: 'quality',
              status: 'IN_PROGRESS',
              conclusion: '',
              run: 2,
            }),
          ],
        },
        {
          statusCheckRollup: [
            ...cancelled,
            check({ name: 'quality', run: 2 }),
            check({ run: 2 }),
          ],
        },
      ],
    });
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Waiting for check, quality on');
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
  });

  it("doesn't skip a failure's pending replacement with --no-wait", () => {
    const failed = check({ conclusion: 'FAILURE' });
    openPr({
      mergeStateStatus: 'UNSTABLE',
      polls: [
        {
          statusCheckRollup: [
            failed,
            check({ status: 'QUEUED', conclusion: '', run: 2 }),
          ],
        },
        {
          statusCheckRollup: [failed, check({ conclusion: 'SKIPPED', run: 2 })],
        },
      ],
    });
    const result = land(fixture, ['123', '--no-wait']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('check failed on');
    expect(mergeCalls(fixture)).toEqual([]);
  });
});

describe('standards land with a replaced failure and other checks', () => {
  it("keeps a failure that a later job of its own run doesn't replace", () => {
    // Run 2's check of another name makes the failure look contested.
    openPr({
      statusCheckRollup: [
        check({ name: 'test', conclusion: 'FAILURE' }),
        {
          ...check({ name: 'test', started: '2026-01-01T00:05:00Z' }),
          detailsUrl: 'https://github.com/test/repo/actions/runs/1/job/10',
        },
        check({ name: 'setup', run: 2 }),
      ],
    });
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('test failed on');
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it('keeps a cancelled check of the newest run when a failure is replaced', () => {
    // A later attempt of run 1 passed lint, which the newest run cancelled.
    const lint = [
      check({ name: 'lint', conclusion: 'CANCELLED', run: 2 }),
      check({ name: 'lint', started: '2026-01-01T00:05:00Z' }),
    ];
    const aggregate = [
      check({ conclusion: 'FAILURE', run: 2 }),
      check({ started: '2026-01-01T00:05:00Z' }),
    ];
    for (const statusCheckRollup of [lint, [...lint, ...aggregate]]) {
      openPr({ statusCheckRollup });
      const result = land(fixture, ['123']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('lint failed on');
      expect(mergeCalls(fixture)).toEqual([]);
    }
  });
});

describe('standards land with cancelled checks', () => {
  it('ignores a check that a newer run cancelled', () => {
    openPr({
      statusCheckRollup: [
        check({ conclusion: 'CANCELLED', run: 1 }),
        check({ run: 2 }),
      ],
    });
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
  });

  it('waits for the replacement of a cancelled check', () => {
    // Marking a draft ready starts a run that cancels the one in progress,
    // and the cancelled check can show before the new run's checks do.
    const cancelled = check({ conclusion: 'CANCELLED' });
    openPr({
      polls: [
        {
          isDraft: true,
          mergeStateStatus: 'DRAFT',
          statusCheckRollup: [check({ status: 'IN_PROGRESS', conclusion: '' })],
        },
        {
          mergeStateStatus: 'CLEAN',
          updatedAt: now(),
          statusCheckRollup: [cancelled],
        },
        {
          statusCheckRollup: [
            cancelled,
            check({ status: 'IN_PROGRESS', conclusion: '', run: 2 }),
          ],
        },
        {
          updatedAt: OLD_UPDATE,
          statusCheckRollup: [cancelled, check({ run: 2 })],
        },
      ],
    });
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
  });

  it('fails a cancelled check without a replacement once quiet', () => {
    openPr({
      polls: [
        {
          updatedAt: now(),
          statusCheckRollup: [check({ conclusion: 'CANCELLED' })],
        },
        { updatedAt: OLD_UPDATE },
      ],
    });
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Waiting for check on');
    expect(result.stderr).toContain('check failed on');
    expect(mergeCalls(fixture)).toEqual([]);
  });
});
