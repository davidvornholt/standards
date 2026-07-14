import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import { atomicRecordTemporaryName } from './sync-transaction-artifact-names';

const PRIVATE_MODE = 0o600;
const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

const writeBounded = async (
  handle: Awaited<ReturnType<typeof open>>,
  contents: Buffer,
  afterPartialWrite?: () => Promise<void>,
): Promise<void> => {
  const split = Math.max(1, Math.floor(contents.byteLength / 2));
  let offset = 0;
  while (offset < contents.byteLength) {
    const end = offset === 0 ? split : contents.byteLength;
    // biome-ignore lint/performance/noAwaitInLoops: short writes must be completed on one descriptor
    const { bytesWritten } = await handle.write(
      contents,
      offset,
      end - offset,
      null,
    );
    if (bytesWritten === 0) {
      throw new Error('Atomic transaction record write made no progress');
    }
    offset += bytesWritten;
    if (offset === split) {
      // The hook models a crash while the final path is still absent.
      await afterPartialWrite?.();
    }
  }
};

export const publishAtomicTransactionRecord = async ({
  afterFinalSync,
  afterPartialWrite,
  contents,
  directory,
  finalName,
  maximumBytes,
}: {
  readonly afterFinalSync?: () => Promise<void>;
  readonly afterPartialWrite?: () => Promise<void>;
  readonly contents: string;
  readonly directory: PinnedDirectory;
  readonly finalName: string;
  readonly maximumBytes: number;
}): Promise<void> => {
  const encoded = Buffer.from(contents);
  if (encoded.byteLength > maximumBytes) {
    throw new Error(`Transaction record exceeds its size limit: ${finalName}`);
  }
  const temporaryName = atomicRecordTemporaryName(finalName, randomUUID());
  const temporaryPath = directoryEntryPath(directory, temporaryName);
  const finalPath = directoryEntryPath(directory, finalName);
  const handle = await open(
    temporaryPath,
    constants.O_CREAT +
      constants.O_EXCL +
      constants.O_WRONLY +
      constants.O_NOFOLLOW,
    PRIVATE_MODE,
  );
  let temporaryIdentity: NodeIdentity | null = null;
  try {
    const info = await handle.stat();
    temporaryIdentity = { dev: info.dev, ino: info.ino };
    await writeBounded(handle, encoded, afterPartialWrite);
    await handle.sync();
  } catch (error) {
    await handle.close();
    if (temporaryIdentity !== null) {
      await cleanupTemporary(
        directory,
        temporaryName,
        temporaryPath,
        temporaryIdentity,
      );
    }
    throw error;
  }
  await handle.close();
  try {
    await link(temporaryPath, finalPath);
    await syncPinnedDirectory(directory);
    await afterFinalSync?.();
    const currentTemporary = await regularAtomicRecordIdentity(
      directory,
      temporaryName,
    );
    if (!identitiesMatch(temporaryIdentity, currentTemporary)) {
      throw new Error(
        `Atomic transaction record tail changed: ${temporaryName}`,
      );
    }
    await unlink(temporaryPath);
    await syncPinnedDirectory(directory);
  } catch (error) {
    if (temporaryIdentity !== null) {
      await cleanupTemporary(
        directory,
        temporaryName,
        temporaryPath,
        temporaryIdentity,
      );
    }
    throw error;
  }
};

export const regularAtomicRecordIdentity = async (
  directory: PinnedDirectory,
  name: string,
) => {
  const handle = await open(
    directoryEntryPath(directory, name),
    constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`Atomic transaction record must be regular: ${name}`);
    }
    return { dev: info.dev, ino: info.ino };
  } finally {
    await handle.close();
  }
};

const cleanupTemporary = async (
  directory: PinnedDirectory,
  name: string,
  path: string,
  expected: { readonly dev: number; readonly ino: number },
): Promise<void> => {
  let current: { readonly dev: number; readonly ino: number };
  try {
    current = await regularAtomicRecordIdentity(directory, name);
  } catch (error) {
    if (missing(error)) {
      return;
    }
    throw error;
  }
  if (!identitiesMatch(expected, current)) {
    throw new Error(`Atomic transaction record tail changed: ${name}`);
  }
  await unlink(path);
  await syncPinnedDirectory(directory);
};
