import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import {
  identitiesMatch,
  identityOf,
  type NodeIdentity,
} from './sync-filesystem';
import { isMissingFilesystemError } from './sync-filesystem-error';

const FILE_TYPE_MODE_BASE = 0o1000;
const DECIMAL_RADIX = 10;

export type GitExcludeSnapshot = {
  readonly contents: string;
  readonly identity: NodeIdentity;
  readonly mode: number;
};

export const readGitExclude = async (
  info: PinnedDirectory,
  name = 'exclude',
): Promise<GitExcludeSnapshot | null> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      directoryEntryPath(info, name),
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      return null;
    }
    throw new Error('Git recovery-artifact exclusion target must be real', {
      cause: error,
    });
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile()) {
      throw new Error('Git recovery-artifact exclusion target must be a file');
    }
    return {
      contents: await handle.readFile({ encoding: 'utf8' }),
      identity: identityOf(metadata),
      mode: Number.parseInt(
        (metadata.mode % BigInt(FILE_TYPE_MODE_BASE)).toString(),
        DECIMAL_RADIX,
      ),
    };
  } finally {
    await handle.close();
  }
};

export const gitExcludeSnapshotsMatch = (
  left: GitExcludeSnapshot | null,
  right: GitExcludeSnapshot | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    identitiesMatch(left.identity, right.identity) &&
    left.mode === right.mode &&
    left.contents === right.contents);
