import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { writeCompleteDescriptor } from './sync-descriptor-write';
import {
  directoryEntryPath,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import type { NodeIdentity } from './sync-filesystem';
import { identitiesMatch, identityOf } from './sync-filesystem';
import { isMissingFilesystemError } from './sync-filesystem-error';
import { linkDescriptorNoReplace } from './sync-linux-link';
import { atomicRecordTemporaryName } from './sync-transaction-artifact-names';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';

const PRIVATE_MODE = 0o600;

export const publishAtomicTransactionRecord = async ({
  afterFinalSync,
  afterPartialWrite,
  afterTemporaryBind,
  afterTemporaryOpen,
  afterFinalPublish,
  beforeFinalPublish,
  beforeTemporaryBind,
  beforeTemporaryOpen,
  contents,
  directory,
  finalName,
  maximumBytes,
  temporaryName: requestedTemporaryName,
}: {
  readonly afterFinalPublish?: () => Promise<void>;
  readonly afterFinalSync?: () => Promise<void>;
  readonly afterPartialWrite?: () => Promise<void>;
  readonly afterTemporaryBind?: (name: string) => Promise<void>;
  readonly afterTemporaryOpen?: (identity: NodeIdentity) => Promise<void>;
  readonly beforeFinalPublish?: () => Promise<void>;
  readonly beforeTemporaryBind?: () => Promise<void>;
  readonly beforeTemporaryOpen?: () => Promise<void>;
  readonly contents: string;
  readonly directory: PinnedDirectory;
  readonly finalName: string;
  readonly maximumBytes: number;
  readonly temporaryName?: string;
}): Promise<void> => {
  const encoded = Buffer.from(contents);
  if (encoded.byteLength > maximumBytes) {
    throw new Error(`Transaction record exceeds its size limit: ${finalName}`);
  }
  const temporaryName =
    requestedTemporaryName ??
    atomicRecordTemporaryName(finalName, randomUUID());
  const temporaryPath = directoryEntryPath(directory, temporaryName);
  const finalPath = directoryEntryPath(directory, finalName);
  await beforeTemporaryOpen?.();
  const handle = await open(
    temporaryPath,
    constants.O_CREAT +
      constants.O_EXCL +
      constants.O_WRONLY +
      constants.O_NOFOLLOW,
    PRIVATE_MODE,
  );
  let temporaryIdentity: NodeIdentity | null = null;
  let published = false;
  try {
    const info = await handle.stat({ bigint: true });
    temporaryIdentity = identityOf(info);
    await afterTemporaryOpen?.(temporaryIdentity);
    await writeCompleteDescriptor({
      afterPartialWrite,
      contents: encoded,
      handle,
      partialOffset: Math.max(1, Math.floor(encoded.byteLength / 2)),
    });
    await handle.sync();
    await beforeFinalPublish?.();
    try {
      linkDescriptorNoReplace(handle.fd, directory.handle.fd, finalName);
    } catch (error) {
      let existing: Awaited<ReturnType<typeof open>>;
      try {
        existing = await open(
          finalPath,
          constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
        );
      } catch (inspectionError) {
        // biome-ignore lint/style/useErrorCause: AggregateError retains both publication and inspection failures.
        throw new AggregateError(
          [error, inspectionError],
          `Could not inspect existing record: ${finalName}`,
          { cause: inspectionError },
        );
      }
      await existing.close();
      throw Object.assign(
        new Error(`Transaction record already exists: ${finalName}`, {
          cause: error,
        }),
        { code: 'EEXIST' },
      );
    }
    published = true;
    await afterFinalPublish?.();
    const final = await open(
      finalPath,
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
    );
    try {
      const finalInfo = await final.stat({ bigint: true });
      const finalContents = await final.readFile();
      if (
        !(
          finalInfo.isFile() &&
          identitiesMatch(temporaryIdentity, identityOf(finalInfo)) &&
          finalContents.equals(encoded)
        )
      ) {
        throw new Error(`Published transaction record changed: ${finalName}`);
      }
    } finally {
      await final.close();
    }
    await syncPinnedDirectory(directory);
    await afterFinalSync?.();
    await bindAndRemoveEntry({
      afterBind: () => afterTemporaryBind?.(temporaryName) ?? Promise.resolve(),
      beforeBind: beforeTemporaryBind,
      directory,
      expected: temporaryIdentity,
      kind: 'file',
      name: temporaryName,
    });
  } finally {
    await handle.close();
    if (!published && temporaryIdentity !== null) {
      await cleanupTemporary(directory, temporaryName, temporaryIdentity);
    }
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
    return identityOf(info);
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
    if (isMissingFilesystemError(error)) {
      return;
    }
    throw error;
  }
};
