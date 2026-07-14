import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { writeCompleteDescriptor } from './sync-descriptor-write';
import {
  directoryEntryPath,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import type { NodeIdentity } from './sync-filesystem';
import { linkDescriptorNoReplace } from './sync-linux-link';
import {
  readQuarantineRecordFile,
  readQuarantineRecordHandle,
  sameQuarantineRecord,
} from './sync-transaction-quarantine-file';
import {
  assertValidQuarantineOriginal,
  type QuarantineRecord,
  quarantineDraftName,
  quarantineRecordContents,
  quarantineRecordNames,
  quarantineToken,
} from './sync-transaction-quarantine-schema';

const PRIVATE_MODE = 0o600;
const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

const openExistingTail = async (
  directory: PinnedDirectory,
  name: string,
): Promise<FileHandle | null> => {
  try {
    return await open(
      directoryEntryPath(directory, name),
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
    );
  } catch (error) {
    if (missing(error)) {
      return null;
    }
    throw error;
  }
};

const createDraft = async (
  directory: PinnedDirectory,
  record: QuarantineRecord,
  afterPartialWrite?: () => Promise<void>,
): Promise<FileHandle> => {
  const handle = await open(
    directoryEntryPath(
      directory,
      quarantineDraftName(record.token, randomUUID()),
    ),
    constants.O_CREAT +
      constants.O_EXCL +
      constants.O_RDWR +
      constants.O_NOFOLLOW,
    PRIVATE_MODE,
  );
  try {
    await writeCompleteDescriptor({
      afterPartialWrite,
      contents: Buffer.from(quarantineRecordContents(record)),
      handle,
      partialOffset: 1,
    });
    await handle.sync();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const selectTail = async (
  directory: PinnedDirectory,
  record: QuarantineRecord,
  afterPartialWrite?: () => Promise<void>,
) => {
  const names = quarantineRecordNames(record.token);
  const existing = await openExistingTail(directory, names.tail);
  if (existing !== null) {
    return {
      handle: existing,
      snapshot: await readQuarantineRecordHandle(existing),
    };
  }
  const draft = await createDraft(directory, record, afterPartialWrite);
  const snapshot = await readQuarantineRecordHandle(draft);
  try {
    linkDescriptorNoReplace(draft.fd, directory.handle.fd, names.tail);
  } catch (error) {
    const winner = await openExistingTail(directory, names.tail);
    if (winner === null) {
      await draft.close();
      throw error;
    }
    await draft.close();
    return {
      handle: winner,
      snapshot: await readQuarantineRecordHandle(winner),
    };
  }
  const published = await readQuarantineRecordFile(directory, names.tail);
  if (!sameQuarantineRecord(snapshot, published)) {
    await draft.close();
    throw new Error('Quarantine ownership tail publication changed');
  }
  return { handle: draft, snapshot };
};

export const publishQuarantineRecord = async ({
  directory,
  hooks = {},
  identity,
  kind,
  original,
}: {
  readonly directory: PinnedDirectory;
  readonly hooks?: {
    readonly afterPartialWrite?: () => Promise<void>;
    readonly afterTailSync?: () => Promise<void>;
  };
  readonly identity: NodeIdentity;
  readonly kind: QuarantineRecord['kind'];
  readonly original: string;
}): Promise<QuarantineRecord> => {
  assertValidQuarantineOriginal(original);
  const token = quarantineToken(original, identity, kind);
  const record = { identity, kind, original, token } as const;
  const names = quarantineRecordNames(token);
  const tail = await selectTail(directory, record, hooks.afterPartialWrite);
  try {
    if (tail.snapshot.contents !== quarantineRecordContents(record)) {
      throw new Error('Quarantine ownership record changed');
    }
    await syncPinnedDirectory(directory);
    await hooks.afterTailSync?.();
    try {
      linkDescriptorNoReplace(
        tail.handle.fd,
        directory.handle.fd,
        names.record,
      );
    } catch (error) {
      const published = await readQuarantineRecordFile(directory, names.record);
      if (!sameQuarantineRecord(tail.snapshot, published)) {
        throw error;
      }
    }
    const [publishedTail, publishedRecord] = await Promise.all([
      readQuarantineRecordFile(directory, names.tail),
      readQuarantineRecordFile(directory, names.record),
    ]);
    if (
      !(
        sameQuarantineRecord(tail.snapshot, publishedTail) &&
        sameQuarantineRecord(tail.snapshot, publishedRecord)
      )
    ) {
      throw new Error('Quarantine ownership record publication changed');
    }
    await syncPinnedDirectory(directory);
  } finally {
    await tail.handle.close();
  }
  return record;
};
