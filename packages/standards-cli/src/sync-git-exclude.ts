import { spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { gitChildEnvironment } from './git-child-environment';
import type { RepositoryRoot } from './sync-filesystem';
import { isMissingFilesystemError } from './sync-filesystem-error';
import {
  type GitExcludeUpdateHooks,
  updatePinnedGitExclude,
} from './sync-git-exclude-filesystem';
import { assertRepositoryRootUnchanged } from './sync-repository-root-generation';
import { GIT_RECOVERY_ARTIFACT_EXCLUDES as TRANSACTION_ARTIFACT_EXCLUDES } from './sync-transaction-namespace';

const BLOCK_BEGIN = '# BEGIN @davidvornholt/standards recovery artifacts';
const BLOCK_END = '# END @davidvornholt/standards recovery artifacts';
export const GIT_RECOVERY_ARTIFACT_EXCLUDES = TRANSACTION_ARTIFACT_EXCLUDES;

const exclusionBlock = [
  BLOCK_BEGIN,
  ...GIT_RECOVERY_ARTIFACT_EXCLUDES,
  BLOCK_END,
  '',
].join('\n');

const withExclusionBlock = (contents: string): string => {
  const lines = contents.split('\n');
  const begins = lines.flatMap((line, index) =>
    line === BLOCK_BEGIN ? [index] : [],
  );
  const ends = lines.flatMap((line, index) =>
    line === BLOCK_END ? [index] : [],
  );
  if (
    begins.length > 1 ||
    ends.length > 1 ||
    begins.length !== ends.length ||
    (begins[0] !== undefined && ends[0] !== undefined && begins[0] >= ends[0])
  ) {
    throw new Error('Git recovery-artifact exclusion block is malformed');
  }
  const remaining =
    begins[0] === undefined || ends[0] === undefined
      ? lines
      : lines.filter((_, index) => index < begins[0] || index > ends[0]);
  while (remaining.at(-1) === '') {
    remaining.pop();
  }
  const prefix = remaining.length === 0 ? '' : `${remaining.join('\n')}\n\n`;
  return `${prefix}${exclusionBlock}`;
};

const gitPath = (
  root: RepositoryRoot,
  arguments_: ReadonlyArray<string>,
): string => {
  const result = spawnSync(
    'git',
    ['-C', root.path, 'rev-parse', '--path-format=absolute', ...arguments_],
    { encoding: 'utf8', env: gitChildEnvironment() },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('Could not inspect Git recovery-artifact exclusions', {
      cause: result.error ?? new Error(result.stderr.trim()),
    });
  }
  return result.stdout.trimEnd();
};

export const ensureGitRecoveryArtifactsExcluded = async (
  root: RepositoryRoot,
  hooks: GitExcludeUpdateHooks = {},
): Promise<void> => {
  await assertRepositoryRootUnchanged(root);
  try {
    const metadata = await lstat(`${root.path}/.git`);
    if (
      metadata.isSymbolicLink() ||
      !(metadata.isDirectory() || metadata.isFile())
    ) {
      throw new Error('Git metadata entry must be a file or directory');
    }
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      await assertRepositoryRootUnchanged(root);
      return;
    }
    throw error;
  }
  await assertRepositoryRootUnchanged(root);
  const worktree = await realpath(gitPath(root, ['--show-toplevel']));
  if (worktree !== root.path) {
    throw new Error('Standards consumer must be the Git worktree root');
  }
  const commonPath = gitPath(root, ['--git-common-dir']);
  await assertRepositoryRootUnchanged(root);
  const guardedHooks: GitExcludeUpdateHooks = {
    beforeExchange: hooks.beforeExchange,
    beforePublication: async () => {
      await hooks.beforePublication?.();
      await assertRepositoryRootUnchanged(root);
    },
    beforeReplace: async () => {
      await hooks.beforeReplace?.();
      await assertRepositoryRootUnchanged(root);
    },
    beforeTemporaryWrite: async () => {
      await hooks.beforeTemporaryWrite?.();
      await assertRepositoryRootUnchanged(root);
    },
  };
  await updatePinnedGitExclude(commonPath, withExclusionBlock, guardedHooks);
  await assertRepositoryRootUnchanged(root);
};
