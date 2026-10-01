import { afterEach, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, mkTmp, write } from './cli-test-support';
import {
  type FakePullRequest,
  fakeGitHub,
  RECONCILE_STEP,
  runSyncStep,
  SYNC_BRANCH,
} from './standards-sync-workflow-test-support';

afterEach(cleanupTmpDirs);

const FIRST_LEGACY_NUMBER = 3;
const SECOND_LEGACY_NUMBER = 4;
const UNRELATED_NUMBER = 5;
const FORK_NUMBER = 6;
// The fake opens the next number after every PR in its state.
const CREATED_NUMBER = 7;
const REUSABLE_NUMBER = 8;

const pullRequest = (
  number: number,
  headRefName: string,
  isCrossRepository = false,
): FakePullRequest => ({ number, headRefName, isCrossRepository });
const LEGACY = [
  pullRequest(FIRST_LEGACY_NUMBER, 'standards-sync/20260907111610'),
  pullRequest(SECOND_LEGACY_NUMBER, 'standards-sync/20260914112611'),
];
// Neither is a same-repository PR in the workflow-owned branch namespace.
const UNRELATED = [
  pullRequest(UNRELATED_NUMBER, 'feature/standards-sync'),
  pullRequest(FORK_NUMBER, 'standards-sync/fork', true),
];
const REUSABLE = pullRequest(REUSABLE_NUMBER, SYNC_BRANCH);
const SUPERSEDED_BY_BASE =
  'Closed because the base branch already matches the upstream standards.';
const supersededBy = (number: number): string =>
  `Superseded by #${number}, the current standards sync pull request.`;
const closures = (
  closed: ReadonlyArray<FakePullRequest>,
  comment: string,
): string => closed.map(({ number }) => `${number} ${comment}\n`).join('');

const reconcile = (
  open: ReadonlyArray<FakePullRequest>,
  values: Record<string, string>,
) => {
  const root = mkTmp('sync-supersede-');
  const github = fakeGitHub(root, process.env.PATH ?? '');
  write(root, 'pr-state', JSON.stringify(open));
  const result = runSyncStep(root, RECONCILE_STEP, {
    ...process.env,
    ...github,
    ...values,
  });
  const read = (name: string): string =>
    existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : '';
  return {
    status: result.status,
    open: JSON.parse(read('pr-state')) as Array<FakePullRequest>,
    closures: read('pr-closures'),
    creations: read('pr-creations'),
  };
};
const workflowEnv = (
  mirrorChanged: boolean,
  failure: 'none' | 'create' | 'close' = 'none',
): Record<string, string> =>
  Object.fromEntries([
    ['MIRROR_CHANGED', String(mirrorChanged)],
    ['FAIL_CREATE', String(failure === 'create')],
    ['FAIL_CLOSE', String(failure === 'close')],
  ]);

it.each([
  { reusableOpen: false, current: CREATED_NUMBER },
  { reusableOpen: true, current: REUSABLE_NUMBER },
])(
  'closes older sync PRs in favor of the current one (reusable PR already open: $reusableOpen)',
  ({ reusableOpen, current }) => {
    const outcome = reconcile(
      [...LEGACY, ...UNRELATED, ...(reusableOpen ? [REUSABLE] : [])],
      workflowEnv(true),
    );

    expect(outcome.status).toBe(0);
    expect(outcome.open).toEqual([
      ...UNRELATED,
      pullRequest(current, SYNC_BRANCH),
    ]);
    expect(outcome.creations).toBe(reusableOpen ? '' : 'created\n');
    expect(outcome.closures).toBe(closures(LEGACY, supersededBy(current)));
  },
);

it('closes every sync PR when the base branch already matches upstream', () => {
  const outcome = reconcile(
    [...LEGACY, ...UNRELATED, REUSABLE],
    workflowEnv(false),
  );

  expect(outcome.status).toBe(0);
  expect(outcome.open).toEqual(UNRELATED);
  expect(outcome.creations).toBe('');
  expect(outcome.closures).toBe(
    closures([...LEGACY, REUSABLE], SUPERSEDED_BY_BASE),
  );
});

it('fails instead of leaving a superseded sync PR open', () => {
  const outcome = reconcile([...LEGACY, REUSABLE], workflowEnv(true, 'close'));

  expect(outcome.status).not.toBe(0);
  expect(outcome.open).toEqual([...LEGACY, REUSABLE]);
});

it('closes nothing when the current sync PR cannot be opened', () => {
  const outcome = reconcile(LEGACY, workflowEnv(true, 'create'));

  expect(outcome.status).not.toBe(0);
  expect(outcome.open).toEqual(LEGACY);
  expect(outcome.closures).toBe('');
});
