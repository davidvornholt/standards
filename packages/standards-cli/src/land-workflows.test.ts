import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import {
  BASE_TIP,
  branchExists,
  CI,
  check,
  createLand,
  type Land,
  land,
  mergeCall,
  mergeCalls,
  now,
  tipLookups,
  workflowReads,
} from './land-test-support';
import { workflowTriggersCi } from './land-workflows';

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

describe('workflowTriggersCi', () => {
  it.each([
    ['on: pull_request\n', true],
    ['on: pull_request_target\n', true],
    ['on: push\n', true],
    ['on: schedule\n', false],
    ['on: workflow_dispatch\n', false],
  ])('reads `on` as one event: %j', (text, expected) => {
    expect(workflowTriggersCi(text)).toBe(expected);
  });

  it.each([
    ['on: [workflow_dispatch, push]\n', true],
    ['on:\n  - schedule\n  - pull_request\n', true],
    ['on: [schedule, workflow_dispatch]\n', false],
  ])('reads `on` as a list of events: %j', (text, expected) => {
    expect(workflowTriggersCi(text)).toBe(expected);
  });

  it.each([
    ['on:\n  push:\n    branches: [main]\n', true],
    ['on:\n  pull_request:\n  workflow_dispatch:\n', true],
    [
      "on:\n  schedule:\n    - cron: '0 4 * * 1'\n  workflow_dispatch:\n",
      false,
    ],
    // A chained run reports on the default branch, not the pull request.
    ['on:\n  workflow_run:\n    workflows: [CI]\n', false],
  ])('reads `on` as a map of events: %j', (text, expected) => {
    expect(workflowTriggersCi(text)).toBe(expected);
  });

  it.each([
    ['an unparseable file', 'on: [push\n'],
    ['duplicate keys', 'on: schedule\non: schedule\n'],
    ['a file that is not a map', '- on: schedule\n'],
    ['a missing `on`', 'name: Nightly\n'],
    ['an `on` of another shape', 'on: 3\n'],
    ['an event that is not a name', 'on: [[schedule]]\n'],
    ['a file GitHub could not return in full', null],
  ])('counts %s as CI', (_case, text) => {
    expect(workflowTriggersCi(text)).toBe(true);
  });
});

describe('standards land without CI', () => {
  it('merges at once when the only workflow runs on a schedule', () => {
    // Without CI, a pull request that changed just now has no checks to wait
    // for.
    fixture.github.workflowFiles = { [SCHEDULED]: SCHEDULE_ONLY };
    Object.assign(fixture.pr, { statusCheckRollup: [], updatedAt: now() });
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
    expect(result.stdout).not.toContain('Waiting for');
    expect(workflowReads(fixture)).toEqual([
      String(fixture.pr.headRefOid),
      BASE_TIP,
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

  it('waits for checks when only the base branch has CI', () => {
    // GitHub runs `pull_request` workflows from the merge into the base branch
    // and `pull_request_target` ones from the base branch, so a branch cut
    // before its base gained CI still gets checks. A base branch that can't
    // be found counts as CI, whatever it holds.
    const cases: ReadonlyArray<readonly [string, Array<string>]> = [
      ['pull_request', [BASE_TIP]],
      ['pull_request_target', [BASE_TIP]],
      ['schedule', []],
    ];
    fixture.github.workflowFiles = { [SCHEDULED]: SCHEDULE_ONLY };
    for (const [trigger, baseTips] of cases) {
      fixture.github.commitWorkflows = {
        [BASE_TIP]: { [CI]: `on: ${trigger}\n` },
      };
      fixture.github.baseTips = baseTips;
      Object.assign(fixture.pr, {
        statusCheckRollup: [],
        polls: [{}, { statusCheckRollup: [check({ conclusion: 'FAILURE' })] }],
      });
      const result = land(fixture, ['123']);
      expect(result.status, trigger).toBe(1);
      expect(result.stderr).toContain('check failed on');
      expect(mergeCalls(fixture)).toEqual([]);
    }
  });

  it("looks up the base branch's tip on every poll", () => {
    // The base branch drops its CI while land waits. Each commit's workflows
    // are still read once.
    const nextTip = 'c'.repeat(BASE_TIP.length);
    fixture.github.workflowFiles = { [SCHEDULED]: SCHEDULE_ONLY };
    fixture.github.commitWorkflows = {
      [BASE_TIP]: { [CI]: 'on: pull_request\n' },
    };
    fixture.github.baseTips = [BASE_TIP, BASE_TIP, nextTip];
    fixture.pr.statusCheckRollup = [];
    const result = land(fixture, ['123']);
    expect(result.status, result.stderr).toBe(0);
    expect(mergeCalls(fixture)).toEqual([mergeCall(fixture)]);
    expect(tipLookups(fixture)).toHaveLength(3);
    expect(workflowReads(fixture)).toEqual([
      String(fixture.pr.headRefOid),
      BASE_TIP,
      nextTip,
    ]);
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
