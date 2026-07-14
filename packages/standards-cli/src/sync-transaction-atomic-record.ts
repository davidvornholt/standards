import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open } from 'node:fs/promises';
import { writeCompleteDescriptor } from './sync-descriptor-write';
import {
  directoryEntryPath,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import type { NodeIdentity } from './sync-filesystem';
import { atomicRecordTemporaryName } from './sync-transaction-artifact-names';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';

const PRIVATE_MODE = 0o600;
const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

export const publishAtomicTransactionRecord = async ({
  afterFinalSync,
  afterPartialWrite,
  afterTemporaryBind,
  afterTemporaryOpen,
  contents,
  directory,
  finalName,
  maximumBytes,
}: {
  readonly afterFinalSync?: () => Promise<void>;
  readonly afterPartialWrite?: () => Promise<void>;
  readonly afterTemporaryBind?: (name: string) => Promise<void>;
  readonly afterTemporaryOpen?: (identity: NodeIdentity) => Promise<void>;
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
    const info = await handle.stat({ bigint: true });
    temporaryIdentity = { dev: info.dev, ino: info.ino };
    await afterTemporaryOpen?.(temporaryIdentity);
    await writeCompleteDescriptor({
      afterPartialWrite,
      contents: encoded,
      handle,
      partialOffset: Math.max(1, Math.floor(encoded.byteLength / 2)),
    });
    await handle.sync();
  } catch (error) {
    await handle.close();
    if (temporaryIdentity !== null) {
      await cleanupTemporary(directory, temporaryName, temporaryIdentity);
    }
    throw error;
  }
  await handle.close();
  if (temporaryIdentity === null) {
    throw new Error(
      `Atomic transaction record identity is missing: ${finalName}`,
    );
  }
  try {
    await link(temporaryPath, finalPath);
    await syncPinnedDirectory(directory);
    await afterFinalSync?.();
    await bindAndRemoveEntry({
      afterBind: () => afterTemporaryBind?.(temporaryName) ?? Promise.resolve(),
      directory,
      expected: temporaryIdentity,
      kind: 'file',
      name: temporaryName,
    });
  } catch (error) {
    await cleanupTemporary(directory, temporaryName, temporaryIdentity);
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
    const info = await handle.stat({ bigint: true });
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
  expected: NodeIdentity,
): Promise<void> => {
  try {
    await bindAndRemoveEntry({ directory, expected, kind: 'file', name });
  } catch (error) {
    if (missing(error)) {
      return;
    }
    throw error;
  }
};
