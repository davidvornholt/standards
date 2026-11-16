import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import {
  branchExists,
  createLand,
  currentBranchOf,
  git,
  type Land,
  land,
  mergeCall,
  mergeCalls,
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

// gh can exit with an error although GitHub merged, as when GitHub's response
// is cut off, so land reads the pull request back before it reports either.
describe('standards land when gh pr merge fails', () => {
  it('keeps the branch when the merge fails', () => {
    openPr();
    fixture.env.GH_MERGE_FAIL = '1';
    const result = land(fixture, ['123']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('was not merged');
    expect(branchExists(fixture)).toBe(true);
  });

  it('confirms a merge that gh reported as failed, then cleans up', () => {
    openPr();
    git(fixture, ['switch', 'feature/topic']);
    fixture.env.GH_MERGE_EOF = '1';
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'gh pr merge failed, but GitHub reports PR #123 as merged.',
    );
    expect(result.stdout).toContain('PR #123 is merged as fffffff.');
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
    expect(branchExists(fixture)).toBe(false);
    expect(currentBranchOf(fixture)).toBe('trunk');
  });

  it('cannot confirm a failed merge when the read-back fails', () => {
    openPr({ readBackFailures: 99 });
    fixture.env.GH_MERGE_EOF = '1';
    const result = land(fixture, ['123']);
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain(
      'Cannot tell whether PR #123 is merged: gh pr merge failed',
    );
    expect(result.stderr).toContain('standards land 123');
    expect(branchExists(fixture)).toBe(true);
  });
});
