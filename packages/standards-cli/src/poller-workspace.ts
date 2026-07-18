// Git workspace management for poller jobs: a bare clone per repository as
// the local cache, plus a throwaway worktree per job. The token never appears
// in argv or remote URLs — a credential helper reads it from the environment.
// Deliberately not `--mirror`: mirror remotes refuse refspec pushes, and the
// poller pushes exactly one branch per job.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { isRecord } from './github-settings-parse';

const TOKEN_ENV = 'STANDARDS_POLLER_GIT_TOKEN';
const CREDENTIAL_HELPER = `!f() { echo username=x-access-token; echo "password=$${TOKEN_ENV}"; }; f`;
const MS_PER_SECOND = 1000;
const GIT_TIMEOUT_SECONDS = 600;
const GIT_TIMEOUT_MS = GIT_TIMEOUT_SECONDS * MS_PER_SECOND;

export type Workspace = {
  readonly dir: string;
  readonly baseSha: string;
  readonly cleanup: () => void;
};

const git = (args: ReadonlyArray<string>, token: string | null): string =>
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
  git(
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
    git(
      [
        '-c',
        'credential.helper=',
        '-c',
        `credential.helper=${CREDENTIAL_HELPER}`,
        'clone',
        '--bare',
        `https://github.com/${repo}.git`,
        cloneDir,
      ],
      token,
    );
    git(
      [
        '-C',
        cloneDir,
        'config',
        'remote.origin.fetch',
        '+refs/heads/*:refs/heads/*',
      ],
      null,
    );
  }
  authedGit(cloneDir, ['fetch', '--prune', 'origin'], token);
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
    git(['-C', cloneDir, 'worktree', 'remove', '--force', workDir], null);
  } catch {
    rmSync(workDir, { recursive: true, force: true });
    git(['-C', cloneDir, 'worktree', 'prune'], null);
  }
  const baseSha = git(['-C', cloneDir, 'rev-parse', startRef], null).trim();
  git(['-C', cloneDir, 'worktree', 'add', '--detach', workDir, baseSha], null);
  git(['-C', workDir, 'checkout', '-B', branch, baseSha], null);
  const cleanup = (): void => {
    try {
      git(['-C', cloneDir, 'worktree', 'remove', '--force', workDir], null);
    } catch {
      rmSync(workDir, { recursive: true, force: true });
      git(['-C', cloneDir, 'worktree', 'prune'], null);
    }
  };
  return { dir: workDir, baseSha, cleanup };
};

export const mergeBase = (
  cloneDir: string,
  refA: string,
  refB: string,
): string => git(['-C', cloneDir, 'merge-base', refA, refB], null).trim();

export const commitCount = (workDir: string, baseSha: string): number =>
  Number.parseInt(
    git(['-C', workDir, 'rev-list', '--count', `${baseSha}..HEAD`], null),
    10,
  );

export const changedPaths = (
  workDir: string,
  baseSha: string,
): ReadonlyArray<string> =>
  git(['-C', workDir, 'diff', '--name-only', baseSha, 'HEAD'], null)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

// Poller-owned fix branches (`poller/*`) are force-pushed — the poller is
// their only writer, and a retry legitimately rewrites them. Review jobs push
// a human's PR branch and must stay fast-forward: if the branch moved while
// the job ran, the push fails and the job fails loudly instead of clobbering.
export const pushBranch = (
  workDir: string,
  branch: string,
  token: string | null,
  options: { readonly force: boolean },
): void => {
  authedGit(
    workDir,
    [
      'push',
      ...(options.force ? ['--force'] : []),
      'origin',
      `HEAD:refs/heads/${branch}`,
    ],
    token,
  );
};

// Canonical files in a consumer checkout, from its sync lock. A repository
// without a lock (the standards source repo itself, or a non-consumer) simply
// contributes no locked paths to the forbidden set.
export const lockedPathsOf = async (
  workDir: string,
): Promise<ReadonlyArray<string>> => {
  const lockPath = join(workDir, 'sync-standards.lock');
  if (!existsSync(lockPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as unknown;
    return isRecord(parsed) && isRecord(parsed.files)
      ? Object.keys(parsed.files)
      : [];
  } catch {
    return [];
  }
};
