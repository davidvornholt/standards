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
  mergesBase,
  NEW_HEAD,
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

describe('standards land on a clean pull request behind its base branch', () => {
  it('updates a clean pull request that lacks its base branch, then waits for the new head', () => {
    fixture.github.behindBy = [2, 0];
    mergesBase(fixture);
    openPr({
      polls: [
        {},
        {
          headRefOid: NEW_HEAD,
          statusCheckRollup: [check({ status: 'IN_PROGRESS', conclusion: '' })],
          updatedAt: now(),
        },
        { statusCheckRollup: [check()], updatedAt: OLD_UPDATE },
      ],
    });
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(calls(fixture, 'pr', 'update-branch')).toHaveLength(1);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture, NEW_HEAD)]);
    expect(result.stdout).toContain('Waiting for check on aaaaaaa.');
  });

  it('merges a clean pull request that has its base branch', () => {
    openPr();
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(calls(fixture, 'pr', 'update-branch')).toEqual([]);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
    expect(
      calls(fixture, 'api').filter((call) =>
        call[1]?.startsWith('repos/test/repo/compare/trunk...'),
      ),
    ).toHaveLength(1);
  });

  it('updates a clean pull request that lacks its base branch with --no-wait, without waiting for the new head', () => {
    // --no-wait skips waiting for checks, as it does after an update of a
    // branch that GitHub reports as behind. It doesn't skip the update.
    fixture.github.behindBy = [1, 0];
    mergesBase(fixture);
    openPr({
      polls: [
        {},
        {
          headRefOid: NEW_HEAD,
          statusCheckRollup: [check({ status: 'IN_PROGRESS', conclusion: '' })],
        },
      ],
    });
    const result = land(fixture, ['123', '--no-wait']);
    expect(result.status, result.stderr).toBe(0);
    expect(calls(fixture, 'pr', 'update-branch')).toHaveLength(1);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture, NEW_HEAD)]);
  });

  it("doesn't merge when it can't tell whether the branch is behind", () => {
    openPr();
    fixture.env.GH_BEHIND_FAIL = '1';
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(mergeCalls(fixture)).toEqual([]);
  });
});
