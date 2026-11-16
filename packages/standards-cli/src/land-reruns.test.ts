import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import type { FakeRun } from './land-fake-gh-test-support';
import {
  calls,
  check,
  createLand,
  type Land,
  land,
  mergeCall,
  mergeCalls,
} from './land-test-support';

let fixture: Land;

beforeEach(() => {
  fixture = createLand(process.env);
  fixture.pr.state = 'OPEN';
});

afterEach(() => {
  cleanupTmpDirs();
});

const sync = check({ name: 'sync', run: 2 });
const quality = (status: string, conclusion: string): Record<string, string> =>
  check({ name: 'quality', status, conclusion });

const standards = (fields: Partial<FakeRun> = {}): FakeRun => ({
  name: 'Standards',
  event: 'pull_request',
  status: 'queued',
  // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
  head_branch: 'feature/topic',
  ...fields,
});

const runLookups = (): number =>
  calls(fixture, 'api').filter((call) => call[1]?.includes('/actions/runs?'))
    .length;

describe('standards land while a workflow run on the head is unfinished', () => {
  it('waits for a rerun that shows no checks yet, then refuses its failure', () => {
    Object.assign(fixture.pr, {
      statusCheckRollup: [sync],
      polls: [
        {},
        { statusCheckRollup: [sync, quality('QUEUED', '')] },
        {
          mergeStateStatus: 'UNSTABLE',
          statusCheckRollup: [sync, quality('COMPLETED', 'FAILURE')],
        },
      ],
    });
    fixture.github.workflowRuns = [[standards()]];
    const result = land(fixture, ['123']);
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain('Waiting for Standards on');
    expect(result.stderr).toContain('Not merging PR #123: quality failed');
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it('merges once the run completes', () => {
    Object.assign(fixture.pr, { statusCheckRollup: [sync] });
    fixture.github.workflowRuns = [
      [standards({ status: 'in_progress' })],
      [standards({ status: 'completed' })],
    ];
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Waiting for Standards on');
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
    expect(runLookups()).toBe(3);
  });

  it('reads the checks again after the run completes, then refuses its failure', () => {
    Object.assign(fixture.pr, {
      statusCheckRollup: [sync],
      polls: [
        {},
        {},
        {
          mergeStateStatus: 'UNSTABLE',
          statusCheckRollup: [sync, quality('COMPLETED', 'FAILURE')],
        },
      ],
    });
    fixture.github.workflowRuns = [
      [standards()],
      [standards({ status: 'completed' })],
    ];
    const result = land(fixture, ['123']);
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain('Not merging PR #123: quality failed');
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it('ignores runs that no pull request event of its branch started', () => {
    Object.assign(fixture.pr, { statusCheckRollup: [sync] });
    fixture.github.workflowRuns = [
      [
        standards({ event: 'workflow_run' }),
        // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
        standards({ event: 'push', head_branch: 'other' }),
      ],
    ];
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
  });

  it('merges past an unfinished run with --no-wait without looking it up', () => {
    Object.assign(fixture.pr, { statusCheckRollup: [sync] });
    fixture.github.workflowRuns = [[standards()]];
    const result = land(fixture, ['123', '--no-wait']);
    expect(result.status, result.stderr).toBe(0);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
    expect(runLookups()).toBe(0);
  });
});
