// The land suites' fixture: a repository whose pull request's branch
// feature/topic is already squash-merged into its base, trunk, and a fake
// `gh` on PATH. Tests adjust `pr` and `github` and then run land, which writes
// them for the fake. Callers pass the inherited environment, so this module
// never reads process state.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { mkTmp, type RunResult } from './cli-test-support';
import {
  type FakeGithub,
  type FakePr,
  installFakeGh,
} from './land-fake-gh-test-support';

const SHA_LENGTH = 40;
export const NEW_HEAD = 'a'.repeat(SHA_LENGTH);
export const BASE_TIP = 'b'.repeat(SHA_LENGTH);
export const CI = '.github/workflows/ci.yml';
export const OLD_UPDATE = '2026-01-01T00:00:00Z';
const CLI = join(import.meta.dir, 'cli.ts');

type CheckOptions = {
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string;
  readonly run?: number;
};

export const check = ({
  name = 'check',
  status = 'COMPLETED',
  conclusion = 'SUCCESS',
  run = 1,
}: CheckOptions = {}): Record<string, string> => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  workflowName: 'CI',
  detailsUrl: `https://github.com/test/repo/actions/runs/${run}/job/9`,
  completedAt: OLD_UPDATE,
});

export const now = (): string => new Date().toISOString();

export type Land = {
  readonly root: string;
  readonly checkout: string;
  readonly env: Record<string, string | undefined>;
  pr: FakePr;
  readonly github: FakeGithub;
};

export const git = (
  fixture: Land,
  args: ReadonlyArray<string>,
  { cwd = fixture.checkout, check: mustPass = true } = {},
): RunResult => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: fixture.env,
  });
  const outcome = {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status ?? 1,
  };
  if (mustPass && outcome.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${outcome.stderr}`);
  }
  return outcome;
};

export const gitOutput = (
  fixture: Land,
  args: ReadonlyArray<string>,
  cwd = fixture.checkout,
): string => git(fixture, args, { cwd }).stdout.trim();

const initialPr = (head: string): FakePr => ({
  number: 123,
  url: 'https://github.com/test/repo/pull/123',
  state: 'MERGED',
  headRefName: 'feature/topic',
  headRefOid: head,
  baseRefName: 'trunk',
  isCrossRepository: false,
  isDraft: false,
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [check()],
  updatedAt: OLD_UPDATE,
  mergeCommit: null,
  polls: [],
});

const initialGithub = (): FakeGithub => ({
  workflows: true,
  workflowsFail: false,
  compare: null,
  ready: null,
  runFiles: { '1': CI, '2': CI },
  workflowFiles: {
    [CI]: 'on:\n  pull_request:\n    types: [opened, ready_for_review]\n',
  },
  commitWorkflows: {},
  baseTips: [BASE_TIP],
});

// Git configuration outside the fixture, such as signing, and a GIT_DIR from
// a hook that runs the suite would leak into its repositories.
export const createLand = (
  inherited: Readonly<Record<string, string | undefined>>,
): Land => {
  const root = mkTmp('land-');
  const checkout = join(root, 'repo');
  const bin = installFakeGh(root);
  const env: Record<string, string | undefined> = Object.fromEntries([
    ...Object.entries(inherited).filter(([key]) => !key.startsWith('GIT_')),
    ['GIT_CONFIG_GLOBAL', '/dev/null'],
    ['GIT_CONFIG_NOSYSTEM', '1'],
    ['PATH', `${bin}:${inherited.PATH ?? ''}`],
    ['LC_ALL', 'C'],
    ['GH_FIXTURE', join(root, 'pr.json')],
    ['GH_GITHUB', join(root, 'github.json')],
    ['GH_CALLS', join(root, 'calls')],
    ['LAND_POLL_SECONDS', '0'],
  ]);
  const fixture: Land = {
    root,
    checkout,
    env,
    pr: initialPr(''),
    github: initialGithub(),
  };
  git(fixture, ['init', '-b', 'trunk', checkout], { cwd: root });
  git(fixture, ['config', 'user.name', 'Test']);
  git(fixture, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(checkout, 'tracked'), 'base\n');
  git(fixture, ['add', '.']);
  git(fixture, ['commit', '-m', 'base']);
  git(fixture, ['switch', '-c', 'feature/topic']);
  writeFileSync(join(checkout, 'tracked'), 'feature\n');
  git(fixture, ['commit', '-am', 'feature']);
  const head = gitOutput(fixture, ['rev-parse', 'HEAD']);
  git(fixture, ['switch', 'trunk']);
  git(fixture, ['merge', '--squash', 'feature/topic']);
  git(fixture, ['commit', '-m', 'squashed feature']);
  fixture.pr = initialPr(head);
  return fixture;
};

export const land = (
  fixture: Land,
  args: ReadonlyArray<string> = [],
  cwd = fixture.checkout,
): RunResult => {
  writeFileSync(fixture.env.GH_FIXTURE ?? '', JSON.stringify(fixture.pr));
  writeFileSync(fixture.env.GH_GITHUB ?? '', JSON.stringify(fixture.github));
  const result = spawnSync(process.execPath, [CLI, 'land', ...args], {
    cwd,
    encoding: 'utf8',
    env: fixture.env,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status ?? 1,
  };
};

export const calls = (
  fixture: Land,
  ...prefix: ReadonlyArray<string>
): Array<Array<string>> => {
  const path = fixture.env.GH_CALLS ?? '';
  const lines = existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean)
    : [];
  return lines
    .map((line) => JSON.parse(line) as Array<string>)
    .filter((call) => prefix.every((part, index) => call[index] === part));
};

const graphqlCalls = (fixture: Land, marker: string): Array<Array<string>> =>
  calls(fixture, 'api', 'graphql').filter((call) =>
    call.some((arg) => arg.includes(marker)),
  );

// Lookups of whether a draft's skipped checks run again when it is ready.
export const lookups = (fixture: Land): Array<Array<string>> =>
  graphqlCalls(fixture, 'checkSuites');

// Reads of a commit's workflow files, as the commit each one read.
export const workflowReads = (fixture: Land): Array<string> =>
  graphqlCalls(fixture, 'isTruncated').map(
    (call) =>
      call
        .find((arg) => arg.startsWith('tree='))
        ?.slice('tree='.length)
        .replace(':.github/workflows', '') ?? '',
  );

// Lookups of the base branch's current tip.
export const tipLookups = (fixture: Land): Array<Array<string>> =>
  graphqlCalls(fixture, 'qualifiedName');

export const mergeCalls = (fixture: Land): Array<Array<string>> =>
  calls(fixture, 'pr', 'merge');

export const mergeCall = (
  fixture: Land,
  head = String(fixture.pr.headRefOid),
): Array<string> => [
  'pr',
  'merge',
  '123',
  '--repo',
  'https://github.com/test/repo',
  '--squash',
  '--match-head-commit',
  head,
];

export const addUpstream = (fixture: Land): string => {
  const remote = join(fixture.root, 'remote.git');
  git(fixture, ['init', '--bare', '-b', 'trunk', remote]);
  git(fixture, ['remote', 'add', 'origin', remote]);
  git(fixture, ['push', '-u', 'origin', 'trunk']);
  return gitOutput(fixture, ['rev-parse', 'origin/trunk']);
};

export const branchExists = (fixture: Land): boolean =>
  git(
    fixture,
    ['show-ref', '--verify', '--quiet', 'refs/heads/feature/topic'],
    {
      check: false,
    },
  ).status === 0;

export const currentBranchOf = (
  fixture: Land,
  cwd = fixture.checkout,
): string => gitOutput(fixture, ['branch', '--show-current'], cwd);
