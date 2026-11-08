import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import { MERGE_COMMIT } from './land-fake-gh-test-support';
import {
  branchExists,
  calls,
  check,
  createLand,
  currentBranchOf,
  git,
  type Land,
  land,
  lookups,
  mergeCall,
  mergeCalls,
  NEW_HEAD,
  now,
  OLD_UPDATE,
  workflowReads,
} from './land-test-support';

// The 45-minute wait takes 180 polls, each a fake gh process.
const FULL_WAIT_MS = 120_000;

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

describe('standards land on an open pull request', () => {
  it('merges, then cleans up and waits for push runs', () => {
    openPr();
    git(fixture, ['switch', 'feature/topic']);
    const result = land(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
    expect(branchExists(fixture)).toBe(false);
    expect(currentBranchOf(fixture)).toBe('trunk');
    expect(result.stderr).not.toContain('Automatically delete head branches');
    expect(result.stdout).toContain('Push runs passed.');
    // Passed checks need no GraphQL; only the merge commit's workflows are
    // read, to find whether it starts push runs.
    expect(calls(fixture, 'api', 'graphql')).toHaveLength(1);
    expect(workflowReads(fixture)).toEqual([MERGE_COMMIT]);
  });

  it('waits for checks on the final head, then merges it', () => {
    // The draft is marked ready, updated with its base, and merged only once
    // the new head's checks pass and its last update is a minute old.
    openPr({
      polls: [
        { isDraft: true, mergeStateStatus: 'DRAFT' },
        { mergeStateStatus: 'BEHIND' },
        {
          headRefOid: NEW_HEAD,
          mergeStateStatus: 'BLOCKED',
          statusCheckRollup: [check({ status: 'IN_PROGRESS', conclusion: '' })],
        },
        {
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: [check()],
          updatedAt: now(),
        },
        { updatedAt: OLD_UPDATE },
      ],
    });
    fixture.github.compare = 'ahead';
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(calls(fixture, 'pr', 'ready')).toHaveLength(1);
    expect(calls(fixture, 'pr', 'update-branch')).toHaveLength(1);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture, NEW_HEAD)]);
    expect(result.stdout).toContain('Waiting for check on aaaaaaa.');
    expect(result.stdout).toContain(
      'Waiting for checks that a recent update may start',
    );
    expect(branchExists(fixture)).toBe(false);
  });
});

describe('standards land with failed or cancelled checks', () => {
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
    ];
    for (const [rollup, options] of cases) {
      openPr({ statusCheckRollup: rollup });
      const result = land(fixture, ['123', ...options]);
      expect(result.status, JSON.stringify(rollup)).toBe(1);
      expect(result.stderr).toContain('lint failed on');
      expect(mergeCalls(fixture)).toEqual([]);
      expect(branchExists(fixture)).toBe(true);
    }
  });

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

describe('standards land with checks skipped as a draft', () => {
  it(
    'never merges on a check skipped as a draft',
    () => {
      // CI that skips its job on drafts leaves a skipped check, which GitHub
      // counts as passed.
      for (const options of [[], ['--no-wait']]) {
        openPr({
          isDraft: true,
          mergeStateStatus: 'DRAFT',
          statusCheckRollup: [check({ conclusion: 'SKIPPED' })],
          polls: [{}, { mergeStateStatus: 'CLEAN' }, {}, { state: 'CLOSED' }],
        });
        const result = land(fixture, ['123', ...options]);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain('became CLOSED while land waited');
        expect(mergeCalls(fixture)).toEqual([]);
      }
      // When no run replaces the skipped check, the 45-minute wait ends with
      // the reason.
      fixture.pr.polls = [{}, { mergeStateStatus: 'CLEAN' }];
      const result = land(fixture, ['123']);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        "check skipped while it was a draft and didn't run again",
      );
      expect(mergeCalls(fixture)).toEqual([]);
    },
    FULL_WAIT_MS,
  );

  it('waits for the replacement of a check skipped as a draft', () => {
    const skipped = check({ conclusion: 'SKIPPED' });
    const polls = (replacement: Record<string, string>) => [
      {},
      { mergeStateStatus: 'CLEAN' },
      {
        statusCheckRollup: [
          skipped,
          check({ status: 'IN_PROGRESS', conclusion: '', run: 2 }),
        ],
      },
      { statusCheckRollup: [skipped, replacement] },
    ];
    openPr({
      isDraft: true,
      mergeStateStatus: 'DRAFT',
      statusCheckRollup: [skipped],
      polls: polls(check({ conclusion: 'FAILURE', run: 2 })),
    });
    const failed = land(fixture, ['123']);
    expect(failed.status, failed.stderr).toBe(1);
    expect(failed.stderr).toContain('check failed on');
    expect(mergeCalls(fixture)).toEqual([]);
    expect(lookups(fixture)).toHaveLength(1);
    fixture.pr.polls = polls(check({ run: 2 }));
    const passed = land(fixture, ['123']);
    expect(passed.status, passed.stderr).toBe(0);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
  });
});

describe('standards land with checks skipped for good', () => {
  it('passes a check skipped by a workflow that ignores the ready event', () => {
    // Like the standards auto-merge workflow, which a draft's ready event
    // never runs again.
    const autoMergeFile = '.github/workflows/auto-merge.yml';
    fixture.github.runFiles['5'] = autoMergeFile;
    fixture.github.workflowFiles[autoMergeFile] =
      'on:\n  pull_request_target:\n    # Not ready_for_review: drafts skip.\n    types: [opened, synchronize]\n';
    const autoMerge = {
      ...check({ name: 'auto-merge', conclusion: 'SKIPPED', run: 5 }),
      workflowName: 'Auto-merge',
    };
    for (const options of [[], ['--no-wait']]) {
      openPr({
        isDraft: true,
        mergeStateStatus: 'DRAFT',
        statusCheckRollup: [autoMerge, check({ run: 2 })],
        polls: [{}, { mergeStateStatus: 'CLEAN' }],
      });
      const result = land(fixture, ['123', ...options]);
      expect(result.status, result.stderr).toBe(0);
      expect(mergeCalls(fixture).slice(-1)).toEqual([mergeCall(fixture)]);
      expect(lookups(fixture).length).toBeGreaterThan(0);
    }
  });

  it('passes a check skipped on a pull request that was never a draft', () => {
    // A pull request that was never a draft has no ready event, and a check
    // skipped after it ran its condition.
    for (const ready of [null, '2025-12-31T00:00:00Z']) {
      fixture.github.ready = ready;
      openPr({
        statusCheckRollup: [
          check({ name: 'lint', conclusion: 'SKIPPED' }),
          check(),
        ],
      });
      const result = land(fixture, ['123', '--no-wait']);
      expect(result.status, result.stderr).toBe(0);
      expect(calls(fixture, 'api', 'graphql').length).toBeGreaterThan(0);
      expect(lookups(fixture)).toEqual([]);
    }
  });
});

describe("standards land and GitHub's merge state", () => {
  it('skips pending checks with --no-wait only where GitHub allows', () => {
    openPr({
      statusCheckRollup: [check({ status: 'IN_PROGRESS', conclusion: '' })],
      mergeStateStatus: 'BLOCKED',
    });
    const blocked = land(fixture, ['123', '--no-wait']);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("--no-wait can't skip them");
    expect(mergeCalls(fixture)).toEqual([]);
    fixture.pr.mergeStateStatus = 'UNSTABLE';
    const unstable = land(fixture, ['123', '--no-wait']);
    expect(unstable.status, unstable.stderr).toBe(0);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
  });

  it('stops waiting on a blocked pull request whose checks passed', () => {
    openPr({ mergeStateStatus: 'BLOCKED' });
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('although its checks passed');
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it('waits for checks unless the head has no workflows', () => {
    openPr({ statusCheckRollup: [], polls: [{}, { state: 'CLOSED' }] });
    const waited = land(fixture, ['123']);
    expect(waited.status).toBe(1);
    expect(waited.stderr).toContain('became CLOSED while land waited');
    expect(mergeCalls(fixture)).toEqual([]);
    // Without workflows, a draft that changed just now merges once it is
    // ready.
    openPr({ polls: [], isDraft: true, updatedAt: now() });
    fixture.github.workflows = false;
    const merged = land(fixture, ['123']);
    expect(merged.status, merged.stderr).toBe(0);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
    expect(calls(fixture, 'run', 'list')).toEqual([]);
  });
});

describe('standards land arguments and merge failures', () => {
  it('refuses unknown options before calling GitHub', () => {
    openPr();
    const result = land(fixture, ['123', '--auto']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unexpected arguments: 123 --auto');
    expect(calls(fixture)).toEqual([]);
  });

  it('keeps the branch when the merge fails', () => {
    openPr();
    fixture.env.GH_MERGE_FAIL = '1';
    const result = land(fixture, ['123']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('was not merged');
    expect(branchExists(fixture)).toBe(true);
  });

  it('prints its usage', () => {
    const result = land(fixture, ['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: standards land [PR_OR_BRANCH]');
    expect(calls(fixture)).toEqual([]);
  });
});
