import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import { MERGE_COMMIT } from './land-fake-gh-test-support';
import {
  branchExists,
  CI,
  calls,
  createLand,
  git,
  type Land,
  land,
  mergeCall,
  mergeCalls,
  now,
  workflowReads,
} from './land-test-support';

const SCHEDULED = '.github/workflows/standards-sync.yml';
const SCHEDULE_ONLY =
  "on:\n  schedule:\n    - cron: '0 4 * * 1'\n  workflow_dispatch:\n";

let fixture: Land;

beforeEach(() => {
  fixture = createLand(process.env);
  fixture.pr.state = 'OPEN';
});

afterEach(() => {
  cleanupTmpDirs();
});

const run = (fields: Record<string, string>): Record<string, string> => ({
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  ...fields,
});

describe('standards land after the merge', () => {
  it('exits by the push runs, after cleaning up', () => {
    const cases = [
      [
        [
          run({
            workflowName: 'Deploy',
            conclusion: 'failure',
            url: 'https://runs/2',
          }),
        ],
        2,
        'Push run Deploy failure: https://runs/2',
      ],
      [[], 0, 'No push runs.'],
    ] as const;
    for (const [runs, code, message] of cases) {
      fixture.github.runs = [...runs];
      const result = land(fixture, ['123']);
      expect(result.status, result.stderr).toBe(code);
      expect(result.stdout + result.stderr).toContain(message);
      expect(branchExists(fixture)).toBe(false);
    }
  });

  it('includes chained runs that appear later', () => {
    // A deploy chained with `on: workflow_run` starts only after the push run
    // it follows has passed. GitHub files it under the default branch's
    // newest commit, here a later merge's.
    const build = run({ workflowName: 'Build', url: 'https://runs/3' });
    const deploy = run({
      workflowName: 'Deploy',
      event: 'workflow_run',
      status: 'in_progress',
      conclusion: '',
      url: 'https://runs/4',
      headSha: 'b'.repeat(40),
      createdAt: '2026-06-01T00:05:00Z',
    });
    const nightly = run({
      workflowName: 'Nightly',
      event: 'schedule',
      conclusion: 'failure',
      url: 'https://runs/5',
    });
    const earlier = run({
      workflowName: 'Deploy',
      event: 'workflow_run',
      conclusion: 'failure',
      url: 'https://runs/6',
      createdAt: '2026-05-31T23:59:59Z',
    });
    const others = [nightly, earlier];
    fixture.github.runPolls = [
      [build, ...others],
      [build, ...others],
      [deploy, build, ...others],
      [
        { ...deploy, status: 'completed', conclusion: 'failure' },
        build,
        ...others,
      ],
    ];
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('Push run Deploy failure: https://runs/4');
    expect(result.stdout).not.toContain('Push runs passed.');
    expect(result.stderr).not.toContain('Nightly');
    expect(result.stderr).not.toContain('runs/6');
  });

  it('only warns when local cleanup fails', () => {
    git(fixture, ['switch', 'feature/topic']);
    git(fixture, ['commit', '--allow-empty', '-m', 'unpublished']);
    const result = land(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'PR #123 is merged, but local cleanup stopped',
    );
    expect(result.stderr).toContain("tip isn't part of merged PR #123");
    expect(branchExists(fixture)).toBe(true);
  });

  it('warns when GitHub keeps merged branches', () => {
    fixture.env.GH_KEEPS_BRANCHES = '1';
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Automatically delete head branches');
  });
});

describe('standards land without CI', () => {
  it('merges at once when the only workflow runs on a schedule', () => {
    // Without CI, a pull request that changed just now has no checks to wait
    // for, and its merge starts no push runs.
    fixture.github.workflowFiles = { [SCHEDULED]: SCHEDULE_ONLY };
    Object.assign(fixture.pr, { statusCheckRollup: [], updatedAt: now() });
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
    expect(result.stdout).not.toContain('Waiting for');
    expect(calls(fixture, 'run', 'list')).toEqual([]);
    expect(workflowReads(fixture)).toEqual([
      String(fixture.pr.headRefOid),
      MERGE_COMMIT,
    ]);
  });

  it('waits for checks when a workflow runs on pull requests', () => {
    fixture.github.workflowFiles = {
      [SCHEDULED]: SCHEDULE_ONLY,
      [CI]: 'on: pull_request\n',
    };
    Object.assign(fixture.pr, {
      statusCheckRollup: [],
      polls: [{}, { state: 'CLOSED' }],
    });
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Waiting for checks');
    expect(result.stderr).toContain('became CLOSED while land waited');
    expect(mergeCalls(fixture)).toEqual([]);
    // Each head's workflows are read once.
    expect(workflowReads(fixture)).toEqual([String(fixture.pr.headRefOid)]);
  });

  it('waits for checks when a workflow file cannot be parsed', () => {
    fixture.github.workflowFiles = {
      [SCHEDULED]: SCHEDULE_ONLY,
      [CI]: 'on: [pull_request\n',
    };
    Object.assign(fixture.pr, {
      statusCheckRollup: [],
      polls: [{}, { state: 'CLOSED' }],
    });
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('became CLOSED while land waited');
    expect(mergeCalls(fixture)).toEqual([]);
  });

  it('stops when the workflows cannot be read', () => {
    fixture.github.workflowsFail = true;
    Object.assign(fixture.pr, { statusCheckRollup: [] });
    const result = land(fixture, ['123']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('standards land: GitHub unavailable');
    expect(mergeCalls(fixture)).toEqual([]);
    expect(branchExists(fixture)).toBe(true);
  });
});
