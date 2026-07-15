import { spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { env } from 'node:process';
import type { RepositoryRoot } from './sync-filesystem';
import {
  type GitExcludeUpdateHooks,
  updatePinnedGitExclude,
} from './sync-git-exclude-filesystem';

const BLOCK_BEGIN = '# BEGIN @davidvornholt/standards recovery artifacts';
const BLOCK_END = '# END @davidvornholt/standards recovery artifacts';
const HEX = '[0-9a-f]';
const THREE_HEX = `${HEX}${HEX}${HEX}`;
const FOUR_HEX = `${THREE_HEX}${HEX}`;
const EIGHT_HEX = `${FOUR_HEX}${FOUR_HEX}`;
const TWELVE_HEX = `${EIGHT_HEX}${FOUR_HEX}`;
const UUID_V4_GITIGNORE = `${EIGHT_HEX}-${FOUR_HEX}-4${THREE_HEX}-[89ab]${THREE_HEX}-${TWELVE_HEX}`;
const GIT_COMMON_DIRECTORY_VARIABLE = 'GIT_COMMON_DIR';
const GIT_DIRECTORY_VARIABLE = 'GIT_DIR';
const GIT_WORK_TREE_VARIABLE = 'GIT_WORK_TREE';

export const GIT_RECOVERY_ARTIFACT_EXCLUDES = [
  '.standards-transaction',
  '.standards-transaction-cleanup',
  '.standards-transaction-owner-reservation',
  '.standards-transaction-reservation',
  `.standards-transaction-reservation.${UUID_V4_GITIGNORE}.tmp`,
  `OWNER.${UUID_V4_GITIGNORE}.tmp`,
  '.standards-transaction-publication-*',
  '.standards-owner-publication-*',
  '.standards-parent-*',
  '.standards-removal-*',
] as const;

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

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  ...env,
  [GIT_COMMON_DIRECTORY_VARIABLE]: undefined,
  [GIT_DIRECTORY_VARIABLE]: undefined,
  [GIT_WORK_TREE_VARIABLE]: undefined,
});

const gitPath = (
  root: RepositoryRoot,
  arguments_: ReadonlyArray<string>,
): string => {
  const result = spawnSync(
    'git',
    ['-C', root.path, 'rev-parse', '--path-format=absolute', ...arguments_],
    { encoding: 'utf8', env: gitEnvironment() },
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
  try {
    const metadata = await lstat(`${root.path}/.git`);
    if (
      metadata.isSymbolicLink() ||
      !(metadata.isDirectory() || metadata.isFile())
    ) {
      throw new Error('Git metadata entry must be a file or directory');
    }
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  const worktree = await realpath(gitPath(root, ['--show-toplevel']));
  if (worktree !== root.path) {
    throw new Error('Standards consumer must be the Git worktree root');
  }
  const commonPath = gitPath(root, ['--git-common-dir']);
  await updatePinnedGitExclude(commonPath, withExclusionBlock, hooks);
};
