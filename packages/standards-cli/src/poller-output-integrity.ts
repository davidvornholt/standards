import { rmSync } from 'node:fs';
import { runGit, type Workspace } from './poller-workspace';

const lines = (value: string): ReadonlyArray<string> =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const GIT_OBJECT_ID = /^[0-9a-f]{40}$/u;
const WHITESPACE = /\s+/u;

export const isGitObjectId = (value: string): boolean =>
  GIT_OBJECT_ID.test(value);

export const dirtyOutputPaths = (workDir: string): ReadonlyArray<string> =>
  runGit(
    [
      '-C',
      workDir,
      'status',
      '--porcelain=v1',
      '--no-renames',
      '-z',
      '--untracked-files=all',
    ],
    null,
  )
    .split('\0')
    .filter((line) => line.length > 0);

export const assertCleanOutputWorktree = (workDir: string): void => {
  const dirty = dirtyOutputPaths(workDir);
  if (dirty.length > 0) {
    throw new Error(
      `refusing to seal a dirty output worktree:\n${dirty.join('\n')}`,
    );
  }
};

export const singleParentOf = (
  cloneDir: string,
  commit: string,
): string | null => {
  const [, parent, extra] = runGit(
    ['-C', cloneDir, 'rev-list', '--parents', '-n', '1', commit],
    null,
  )
    .trim()
    .split(WHITESPACE);
  return parent === undefined || extra !== undefined ? null : parent;
};

export const isAncestor = (
  cloneDir: string,
  ancestor: string,
  descendant: string,
): boolean => {
  try {
    runGit(
      ['-C', cloneDir, 'merge-base', '--is-ancestor', ancestor, descendant],
      null,
    );
    return true;
  } catch {
    return false;
  }
};

export const commitCountBetween = (
  cloneDir: string,
  base: string,
  head: string,
): number =>
  Number.parseInt(
    runGit(['-C', cloneDir, 'rev-list', '--count', `${base}..${head}`], null),
    10,
  );

export const changedPathsBetween = (
  cloneDir: string,
  base: string,
  head: string,
): ReadonlyArray<string> =>
  lines(runGit(['-C', cloneDir, 'diff', '--name-only', base, head], null));

export const createValidationWorktree = (
  cloneDir: string,
  startRef: string,
  workDir: string,
): Workspace => {
  rmSync(workDir, { recursive: true, force: true });
  runGit(['-C', cloneDir, 'worktree', 'prune'], null);
  runGit(
    ['-C', cloneDir, 'worktree', 'add', '--detach', workDir, startRef],
    null,
  );
  const cleanup = (): void => {
    try {
      runGit(['-C', cloneDir, 'worktree', 'remove', '--force', workDir], null);
    } catch {
      rmSync(workDir, { recursive: true, force: true });
      runGit(['-C', cloneDir, 'worktree', 'prune'], null);
    }
  };
  return { dir: workDir, baseSha: startRef, cleanup };
};
