import { afterEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, mkTmp, write } from './cli-test-support';
import {
  SYNC_BRANCH as BRANCH,
  fakeGitHub,
  RECONCILE_STEP,
  runSyncStep,
} from './standards-sync-workflow-test-support';

const git = (cwd: string, ...args: Array<string>): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const shell = (cwd: string, name: string, values: Record<string, string>) =>
  runSyncStep(cwd, name, { ...process.env, ...values });
afterEach(cleanupTmpDirs);

const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const AS_BOT = [
  '-c',
  'user.name=github-actions[bot]',
  '-c',
  `user.email=${BOT_EMAIL}`,
];
type BranchShape = 'bot' | 'person' | 'hand-rebased' | 'merge';

// Builds a sync branch whose commits conflict with a later main on the file
// every sync rewrites, with commits in the given shape on top of the base.
const conflictingSyncBranch = (shape: BranchShape, open: boolean) => {
  const root = mkTmp('sync-conflict-');
  const remote = join(root, 'remote.git');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  const maintainer = join(root, 'maintainer');
  git(root, 'clone', remote, maintainer);
  git(maintainer, 'config', 'user.name', 'fixture');
  git(maintainer, 'config', 'user.email', 'fixture@example.invalid');
  git(maintainer, 'config', 'commit.gpgsign', 'false');
  const commit = (
    content: string,
    identity: ReadonlyArray<string> = [],
    ...options: Array<string>
  ): string => {
    write(maintainer, 'sync-standards.lock', content);
    git(maintainer, 'add', 'sync-standards.lock');
    git(maintainer, ...identity, 'commit', ...options, '-m', content);
    return git(maintainer, 'rev-parse', 'HEAD');
  };
  commit('base\n');
  git(maintainer, 'push', 'origin', 'main');
  if (shape === 'merge') {
    git(maintainer, 'switch', '-c', 'side');
    write(maintainer, 'side.txt', 'side\n');
    git(maintainer, 'add', 'side.txt');
    git(maintainer, ...AS_BOT, 'commit', '-m', 'side');
    git(maintainer, 'switch', 'main');
  }
  git(maintainer, 'switch', '-c', BRANCH);
  // A maintainer who rebases a bot commit by hand becomes its committer.
  const handRebased = shape === 'hand-rebased';
  let stale = commit(
    'earlier sync\n',
    shape === 'person' || handRebased ? [] : AS_BOT,
    ...(handRebased ? [`--author=github-actions[bot] <${BOT_EMAIL}>`] : []),
  );
  if (shape === 'merge') {
    git(maintainer, ...AS_BOT, 'merge', '--no-ff', '-m', 'merge side', 'side');
    stale = git(maintainer, 'rev-parse', 'HEAD');
  }
  git(maintainer, 'push', 'origin', BRANCH);
  git(maintainer, 'switch', 'main');
  const main = commit('later sync\n');
  git(maintainer, 'push', 'origin', 'main');

  const runner = join(root, 'runner');
  git(root, 'clone', remote, runner);
  git(runner, 'config', 'commit.gpgsign', 'false');
  const pullRequests = open
    ? [{ number: 7, headRefName: BRANCH, isCrossRepository: false }]
    : [];
  write(root, 'pr-state', JSON.stringify(pullRequests));
  const values = {
    ...fakeGitHub(root, process.env.PATH ?? ''),
    ...Object.fromEntries([
      ['SYNC_BASE_REF', 'main'],
      ['SYNC_READ_TOKEN', 'read-fixture'],
      ['BRANCH_WRITER_TOKEN', 'write-fixture'],
      ['MIRROR_CHANGED', 'true'],
      ['GITHUB_OUTPUT', join(root, 'output')],
    ]),
  };
  return { root, remote, maintainer, runner, stale, main, values };
};

const rebuiltNotice = (stale: string): string =>
  `::notice::Standards sync PR #7 conflicts with main, and only the sync bot wrote ${BRANCH}; rebuilding it from main and replacing ${stale} in PR #7.`;
const foreignError = (stale: string): string =>
  `::error::Standards sync PR #7 conflicts with main, and ${BRANCH} has commits the sync bot did not write: ${stale}. Rebase ${BRANCH} onto main and push it, or close PR #7 so the next run rebuilds the branch from main.`;

it.each([
  { shape: 'bot', open: true, status: 0, message: rebuiltNotice },
  { shape: 'person', open: true, status: 1, message: foreignError },
  { shape: 'hand-rebased', open: true, status: 1, message: foreignError },
  { shape: 'merge', open: true, status: 1, message: foreignError },
  {
    shape: 'person',
    open: false,
    status: 0,
    message: () =>
      `::notice::No open pull request uses ${BRANCH}; rebuilding it from main`,
  },
] as const)(
  'handles a sync branch that conflicts with main ($shape commits, open PR: $open)',
  ({ shape, open, status, message }) => {
    const { root, remote, runner, stale, main, values } = conflictingSyncBranch(
      shape,
      open,
    );
    const output = values.GITHUB_OUTPUT ?? '';
    const result = shell(runner, 'Prepare reusable sync branch', values);

    expect(result.status).toBe(status);
    expect(result.stdout).toContain(message(stale));
    expect(git(runner, 'rev-parse', 'HEAD')).toBe(status ? stale : main);
    expect(git(runner, 'status', '--porcelain')).toBe('');
    // The writer step leases the push on this head, so a rebuilt branch
    // replaces the stale one only if nobody pushed to it in between.
    expect(existsSync(output) ? readFileSync(output, 'utf8') : '').toBe(
      status ? '' : `previous=${stale}\n`,
    );
    if (status) {
      return;
    }
    write(runner, 'canonical.txt', 'synced\n');
    const runEnv = {
      ...values,
      [['EXPECTED', 'SYNC', 'HEAD'].join('_')]: stale,
    };
    expect(shell(runner, 'Commit and push mirror changes', runEnv).status).toBe(
      0,
    );
    expect(shell(runner, RECONCILE_STEP, runEnv).status).toBe(0);
    expect(git(root, '--git-dir', remote, 'rev-parse', `${BRANCH}~1`)).toBe(
      main,
    );
    // An open sync PR keeps its number and gets the regenerated description.
    expect(JSON.parse(readFileSync(join(root, 'pr-state'), 'utf8'))).toEqual([
      { number: 7, headRefName: BRANCH, isCrossRepository: false },
    ]);
    expect(readFileSync(join(root, 'pr-bodies'), 'utf8')).toBe(
      open ? 'edit 7 fixture body\n' : 'create fixture body\n',
    );
    expect(existsSync(join(root, 'pr-closures'))).toBe(false);
  },
);

it('keeps a maintainer commit pushed while a bot-only sync branch is rebuilt', () => {
  const { remote, maintainer, runner, stale, values } = conflictingSyncBranch(
    'bot',
    true,
  );
  expect(shell(runner, 'Prepare reusable sync branch', values).status).toBe(0);
  git(maintainer, 'fetch', 'origin', BRANCH);
  git(maintainer, 'switch', BRANCH);
  write(maintainer, 'seam.txt', 'maintainer configuration\n');
  git(maintainer, 'add', 'seam.txt');
  git(maintainer, 'commit', '-m', 'adapt the consumer');
  git(maintainer, 'push', 'origin', BRANCH);
  const edited = git(maintainer, 'rev-parse', 'HEAD');

  write(runner, 'canonical.txt', 'synced\n');
  expect(
    shell(runner, 'Commit and push mirror changes', {
      ...values,
      [['EXPECTED', 'SYNC', 'HEAD'].join('_')]: stale,
    }).status,
  ).toBe(1);
  expect(git(runner, '--git-dir', remote, 'rev-parse', BRANCH)).toBe(edited);
});
