import { readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import {
  TRANSACTION_COMMITTED,
  TRANSACTION_JOURNAL,
  TRANSACTION_JOURNAL_TEMP,
  TRANSACTION_OWNER,
  type TransactionJournal,
} from './sync-transaction-types';

export const journalArtifactNames = (
  journal: TransactionJournal,
  committed: boolean,
): ReadonlySet<string> =>
  new Set([
    TRANSACTION_OWNER,
    TRANSACTION_JOURNAL,
    ...(committed ? [TRANSACTION_COMMITTED] : []),
    ...journal.operations.flatMap(({ backup, stage }) =>
      stage === null ? [backup] : [backup, stage],
    ),
  ]);

export const unpublishedArtifactNames = new Set([
  TRANSACTION_OWNER,
  TRANSACTION_JOURNAL,
  TRANSACTION_JOURNAL_TEMP,
]);

export const isUnpublishedTransaction = async (
  transaction: PinnedDirectory,
): Promise<boolean> => {
  const entries = await readdir(directoryEntryPath(transaction, '.'));
  return (
    !entries.includes(TRANSACTION_JOURNAL) &&
    entries.every((entry) =>
      [TRANSACTION_OWNER, TRANSACTION_JOURNAL_TEMP].includes(entry),
    )
  );
};
