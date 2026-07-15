import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import { isMissingFilesystemError } from './sync-filesystem-error';
import { publishAtomicTransactionRecord } from './sync-transaction-atomic-record';
import { parseJournal } from './sync-transaction-journal-parser';
import { resolveRemovalEntryName } from './sync-transaction-quarantine-read';
import {
  TRANSACTION_COMMITTED,
  TRANSACTION_JOURNAL,
  TRANSACTION_JOURNAL_TEMP,
  type TransactionJournal,
} from './sync-transaction-types';

const MAX_JOURNAL_BYTES = 1_048_576;

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
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) {
      throw new Error(`Transaction entry must be a regular file: ${name}`);
    }
    if (info.size > BigInt(maximumBytes)) {
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
  await publishAtomicTransactionRecord({
    afterFinalPublish: hooks.afterJournalRename,
    afterPartialWrite: hooks.afterJournalPartialWrite,
    beforeFinalPublish: hooks.beforeJournalRename,
    beforeTemporaryOpen: hooks.beforeJournalTempOpen,
    contents: contents.toString(),
    directory: transaction,
    finalName: TRANSACTION_JOURNAL,
    maximumBytes: MAX_JOURNAL_BYTES,
    temporaryName: TRANSACTION_JOURNAL_TEMP,
  });
};

export const readJournal = async (
  transaction: PinnedDirectory,
): Promise<TransactionJournal> =>
  parseJournal(
    (
      await readRegularEntry(
        transaction,
        await resolveRemovalEntryName(transaction, TRANSACTION_JOURNAL),
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
      if (isMissingFilesystemError(error)) {
        return false;
      }
      throw error;
    });
