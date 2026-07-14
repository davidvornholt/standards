import { readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import { isAtomicRecordTemporaryName } from './sync-transaction-artifact-names';
import { rollbackBindingName } from './sync-transaction-bound-unlink';
import { readQuarantineRecords } from './sync-transaction-quarantine-record';
import {
  isQuarantineDraftName,
  quarantineArtifactNames,
} from './sync-transaction-quarantine-schema';
import {
  removedBackupName,
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
      stage === null
        ? [
            backup,
            removedBackupName(backup),
            rollbackBindingName(backup),
            rollbackBindingName(backup, 'backup'),
          ]
        : [
            backup,
            removedBackupName(backup),
            rollbackBindingName(backup),
            rollbackBindingName(backup, 'backup'),
            stage,
          ],
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
  const records = await readQuarantineRecords(transaction);
  const physical = new Set(records.flatMap(quarantineArtifactNames));
  for (const entry of entries.filter(isQuarantineDraftName)) {
    physical.add(entry);
  }
  return (
    !entries.includes(TRANSACTION_JOURNAL) &&
    entries.every(
      (entry) =>
        physical.has(entry) ||
        [TRANSACTION_OWNER, TRANSACTION_JOURNAL_TEMP].includes(entry),
    ) &&
    records.every(({ original }) =>
      isAtomicRecordTemporaryName(original, TRANSACTION_OWNER),
    )
  );
};
