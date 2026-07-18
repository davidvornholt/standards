// Git workspace management for poller jobs: a bare clone per repository as
// the local cache, plus a throwaway worktree per job. The token never appears
// in argv or remote URLs — a credential helper reads it from the environment.
// Deliberately not `--mirror`: mirror remotes refuse refspec pushes, and the
// poller pushes exactly one branch per job.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const TOKEN_ENV = 'STANDARDS_POLLER_GIT_TOKEN';
const CREDENTIAL_HELPER = `!f() { echo username=x-access-token; echo "password=$${TOKEN_ENV}"; }; f`;
const MS_PER_SECOND = 1000;
const GIT_TIMEOUT_SECONDS = 600;
const GIT_TIMEOUT_MS = GIT_TIMEOUT_SECONDS * MS_PER_SECOND;
const fetchRefspec = '+refs/heads/*:refs/heads/*';

export const githubRepoUrl = (repo: string): string =>
  `https://github.com/${repo}.git`;

export type Workspace = {
  readonly dir: string;
  readonly baseSha: string;
  readonly cleanup: () => void;
};

export const runGit = (
  args: ReadonlyArray<string>,
  token: string | null,
): string =>
  execFileSync('git', [...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(token === null ? {} : { [TOKEN_ENV]: token }),
      // biome-ignore lint/style/useNamingConvention: environment variable names are defined by git.
      GIT_TERMINAL_PROMPT: '0',
    },
  });

const authedGit = (
  cloneDir: string,
  args: ReadonlyArray<string>,
  token: string | null,
): string =>
  runGit(
    [
      '-C',
      cloneDir,
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=${CREDENTIAL_HELPER}`,
      ...args,
    ],
    token,
  );

// Fetch (or first create) the bare cache clone for a repository and return
// its path. Bare clones carry no fetch refspec by default, so one is set
// explicitly; every branch ref stays local so worktrees can base on any ref.
export const ensureCacheClone = (
  cacheDir: string,
  repo: string,
  token: string | null,
): string => {
  const cloneDir = join(cacheDir, `${repo}.git`);
  if (!existsSync(cloneDir)) {
    mkdirSync(cacheDir, { recursive: true });
    runGit(
      [
        '-c',
        'credential.helper=',
        '-c',
        `credential.helper=${CREDENTIAL_HELPER}`,
        'clone',
        '--bare',
        githubRepoUrl(repo),
        cloneDir,
      ],
      token,
    );
    runGit(
      ['-C', cloneDir, 'config', 'remote.origin.fetch', fetchRefspec],
      null,
    );
  }
  runGit(
    ['-C', cloneDir, 'remote', 'set-url', 'origin', githubRepoUrl(repo)],
    null,
  );
  authedGit(
    cloneDir,
    ['fetch', '--prune', githubRepoUrl(repo), fetchRefspec],
    token,
  );
  return cloneDir;
};

// A leaked worktree from a killed run must not wedge its job forever: remove
// any stale registration for this path before adding the new one.
export const createWorktree = (
  cloneDir: string,
  startRef: string,
  branch: string,
  workDir: string,
): Workspace => {
  try {
    runGit(['-C', cloneDir, 'worktree', 'remove', '--force', workDir], null);
  } catch {
    rmSync(workDir, { recursive: true, force: true });
    runGit(['-C', cloneDir, 'worktree', 'prune'], null);
  }
  const baseSha = runGit(['-C', cloneDir, 'rev-parse', startRef], null).trim();
  runGit(
    ['-C', cloneDir, 'worktree', 'add', '--detach', workDir, baseSha],
    null,
  );
  runGit(['-C', workDir, 'checkout', '-B', branch, baseSha], null);
  const cleanup = (): void => {
    try {
      runGit(['-C', cloneDir, 'worktree', 'remove', '--force', workDir], null);
    } catch {
      rmSync(workDir, { recursive: true, force: true });
      runGit(['-C', cloneDir, 'worktree', 'prune'], null);
    }
  };
  return { dir: workDir, baseSha, cleanup };
};

export const mergeBase = (
  cloneDir: string,
  refA: string,
  refB: string,
): string => runGit(['-C', cloneDir, 'merge-base', refA, refB], null).trim();

export const commitCount = (workDir: string, baseSha: string): number =>
  Number.parseInt(
    runGit(['-C', workDir, 'rev-list', '--count', `${baseSha}..HEAD`], null),
    10,
  );

export const changedPaths = (
  workDir: string,
  baseSha: string,
): ReadonlyArray<string> =>
  runGit(['-C', workDir, 'diff', '--name-only', baseSha, 'HEAD'], null)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

// Review branches are fast-forward-only. New poller-owned fix branches use an
// explicit "expected absent" lease, so a pre-existing ref is never overwritten.
export const pushBranch = (
  workDir: string,
  options: {
    readonly repo: string;
    readonly branch: string;
    readonly token: string | null;
    readonly expectedRemoteSha?: string;
  },
): void => {
  authedGit(
    workDir,
    [
      'push',
      ...(options.expectedRemoteSha === undefined
        ? []
        : [
            `--force-with-lease=refs/heads/${options.branch}:${options.expectedRemoteSha}`,
          ]),
      githubRepoUrl(options.repo),
      `HEAD:refs/heads/${options.branch}`,
    ],
    options.token,
  );
};
