import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  directoryEntryPath,
  openPinnedChild,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import {
  identitiesMatch,
  identityOf,
  type NodeIdentity,
} from './sync-filesystem';
import {
  type GitExcludeSnapshot,
  gitExcludeSnapshotsMatch,
  readGitExclude,
} from './sync-git-exclude-snapshot';
import { pinAbsoluteGitDirectory } from './sync-git-metadata-directory';
import { exchangeNames, renameNoReplace } from './sync-linux-rename';

const DEFAULT_MODE = 0o644;

export type GitExcludeUpdateHooks = {
  readonly beforeExchange?: () => Promise<void>;
  readonly beforePublication?: () => Promise<void>;
  readonly beforeReplace?: () => Promise<void>;
  readonly beforeTemporaryWrite?: () => Promise<void>;
};

const assertInfoLinked = async (
  common: PinnedDirectory,
  expected: NodeIdentity,
): Promise<void> => {
  const current = await openPinnedChild(common, 'info');
  try {
    if (!identitiesMatch(current.identity, expected)) {
      throw new Error('Git metadata info directory changed during exclusion');
    }
  } finally {
    await current.handle.close();
  }
};

const exchangeExisting = async (
  info: PinnedDirectory,
  temporaryName: string,
  initial: GitExcludeSnapshot,
  beforeExchange?: () => Promise<void>,
): Promise<void> => {
  await beforeExchange?.();
  exchangeNames(info.handle.fd, temporaryName, info.handle.fd, 'exclude');
  let displacedMatches = false;
  let mismatchCause: unknown;
  try {
    displacedMatches = gitExcludeSnapshotsMatch(
      initial,
      await readGitExclude(info, temporaryName),
    );
  } catch (error) {
    mismatchCause = error;
  }
  if (!displacedMatches) {
    exchangeNames(info.handle.fd, temporaryName, info.handle.fd, 'exclude');
    await syncPinnedDirectory(info);
    throw new Error(
      'Git recovery-artifact exclusion target changed during replacement',
      { cause: mismatchCause },
    );
  }
};

export const updatePinnedGitExclude = async (
  commonPath: string,
  update: (contents: string) => string,
  hooks: GitExcludeUpdateHooks = {},
): Promise<void> => {
  const common = await pinAbsoluteGitDirectory(commonPath);
  let info: PinnedDirectory | undefined;
  try {
    info = await openPinnedChild(common, 'info');
    const initial = await readGitExclude(info);
    const updated = update(initial?.contents ?? '');
    if (updated === initial?.contents) {
      return;
    }
    await hooks.beforeTemporaryWrite?.();
    await assertInfoLinked(common, info.identity);
    const temporaryName = `exclude.standards-${randomUUID()}.tmp`;
    const temporary = await open(
      directoryEntryPath(info, temporaryName),
      constants.O_CREAT +
        constants.O_EXCL +
        constants.O_WRONLY +
        constants.O_NOFOLLOW,
      initial?.mode ?? DEFAULT_MODE,
    );
    const temporaryIdentity = identityOf(
      await temporary.stat({ bigint: true }),
    );
    try {
      await temporary.writeFile(updated);
      await temporary.sync();
      await hooks.beforeReplace?.();
      await assertInfoLinked(common, info.identity);
      const linkedTemporary = await open(
        directoryEntryPath(info, temporaryName),
        constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
      );
      try {
        const metadata = await linkedTemporary.stat({ bigint: true });
        if (!identitiesMatch(identityOf(metadata), temporaryIdentity)) {
          throw new Error('Git recovery-artifact exclusion temporary changed');
        }
      } finally {
        await linkedTemporary.close();
      }
      if (!gitExcludeSnapshotsMatch(initial, await readGitExclude(info))) {
        throw new Error('Git recovery-artifact exclusion target changed');
      }
      if (initial === null) {
        await hooks.beforePublication?.();
        renameNoReplace(
          info.handle.fd,
          temporaryName,
          info.handle.fd,
          'exclude',
        );
      } else {
        await exchangeExisting(info, temporaryName, initial, async () => {
          await hooks.beforeExchange?.();
          await hooks.beforePublication?.();
        });
      }
      await syncPinnedDirectory(info);
      await assertInfoLinked(common, info.identity);
      const final = await readGitExclude(info);
      if (
        final === null ||
        !identitiesMatch(final.identity, temporaryIdentity) ||
        final.contents !== updated
      ) {
        throw new Error('Git recovery-artifact exclusion replacement changed');
      }
    } finally {
      await temporary.close();
    }
  } finally {
    await info?.handle.close();
    await common.handle.close();
  }
};
