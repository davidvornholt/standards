import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { writeCompleteDescriptor } from './sync-descriptor-write';
import {
  directoryEntryPath,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { parseJournal } from './sync-transaction-journal-parser';
import {
  TRANSACTION_COMMITTED,
  TRANSACTION_JOURNAL,
  TRANSACTION_JOURNAL_TEMP,
  type TransactionJournal,
} from './sync-transaction-types';

const PRIVATE_MODE = 0o600;
const MAX_JOURNAL_BYTES = 1_048_576;
const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

const readRegularEntry = async (
  directory: PinnedDirectory,
  name: string,
  maximumBytes: number,
): Promise<Buffer> => {
  const handle = await open(
    directoryEntryPath(directory, name),
    constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`Transaction entry must be a regular file: ${name}`);
    }
    if (info.size > maximumBytes) {
      throw new Error(`Transaction entry exceeds its size limit: ${name}`);
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      // biome-ignore lint/performance/noAwaitInLoops: one file descriptor advances sequentially
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (bytesRead === 0) {
        return buffer.subarray(0, offset);
      }
      offset += bytesRead;
    }
    throw new Error(`Transaction entry exceeds its size limit: ${name}`);
  } finally {
    await handle.close();
  }
};

export type JournalPublicationHooks = {
  readonly afterJournalRename?: () => Promise<void>;
  readonly afterJournalPartialWrite?: () => Promise<void>;
  readonly beforeJournalTempOpen?: () => Promise<void>;
  readonly beforeJournalRename?: () => Promise<void>;
};

export const publishJournal = async (
  transaction: PinnedDirectory,
  journal: TransactionJournal,
  hooks: JournalPublicationHooks = {},
): Promise<void> => {
  const contents = Buffer.from(`${JSON.stringify(journal)}\n`);
  if (contents.byteLength > MAX_JOURNAL_BYTES) {
    throw new Error('Transaction journal exceeds its size limit');
  }
  await hooks.beforeJournalTempOpen?.();
  const handle = await open(
    directoryEntryPath(transaction, TRANSACTION_JOURNAL_TEMP),
    constants.O_CREAT +
      constants.O_EXCL +
      constants.O_WRONLY +
      constants.O_NOFOLLOW,
    PRIVATE_MODE,
  );
  try {
    const split = Math.max(1, Math.floor(contents.byteLength / 2));
    await writeCompleteDescriptor({
      afterPartialWrite: hooks.afterJournalPartialWrite,
      contents,
      handle,
      partialOffset: split,
    });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await hooks.beforeJournalRename?.();
  await rename(
    directoryEntryPath(transaction, TRANSACTION_JOURNAL_TEMP),
    directoryEntryPath(transaction, TRANSACTION_JOURNAL),
  );
  await hooks.afterJournalRename?.();
  await syncPinnedDirectory(transaction);
};

export const readJournal = async (
  transaction: PinnedDirectory,
): Promise<TransactionJournal> =>
  parseJournal(
    (
      await readRegularEntry(
        transaction,
        TRANSACTION_JOURNAL,
        MAX_JOURNAL_BYTES,
      )
    ).toString('utf8'),
  );

export const hasCommittedMarker = async (
  transaction: PinnedDirectory,
): Promise<boolean> =>
  readRegularEntry(transaction, TRANSACTION_COMMITTED, 0)
    .then(() => true)
    .catch((error: unknown) => {
      if (missing(error)) {
        return false;
      }
      throw error;
    });
