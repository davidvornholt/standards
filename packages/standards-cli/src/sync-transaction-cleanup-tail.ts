import { readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import { isMissingFilesystemError } from './sync-filesystem-error';
import { removeOwnedTransactionDurably } from './sync-transaction-durable-cleanup';
import {
  assertTransactionOwner,
  readTransactionOwner,
} from './sync-transaction-ownership';
import { readQuarantineRecords } from './sync-transaction-quarantine-record';
import {
  isQuarantineDraftName,
  quarantineArtifactNames,
} from './sync-transaction-quarantine-schema';
import type { CleanupReservation } from './sync-transaction-reservation';
import { TRANSACTION_OWNER } from './sync-transaction-types';

const optionalOwner = async (
  root: RepositoryRoot,
  transaction: PinnedDirectory,
  id: string,
): Promise<void> => {
  try {
    const owner = await readTransactionOwner(transaction);
    assertTransactionOwner(owner, root.identity, transaction);
    if (owner.id !== id) {
      throw new Error('Transaction owner does not match cleanup reservation');
    }
  } catch (error) {
    if (!isMissingFilesystemError(error)) {
      throw error;
    }
  }
};

export const cleanupOwnerOnlyTail = async ({
  cleanup,
  reservedName,
  root,
  rootDirectory,
  transaction,
}: {
  readonly cleanup: CleanupReservation;
  readonly reservedName: CleanupReservation['reservedName'];
  readonly root: RepositoryRoot;
  readonly rootDirectory: PinnedDirectory;
  readonly transaction: PinnedDirectory;
}): Promise<void> => {
  const entries = await readdir(directoryEntryPath(transaction, '.'));
  const records = await readQuarantineRecords(transaction);
  const ownerRecords = records.filter(
    ({ original }) => original === TRANSACTION_OWNER,
  );
  if (ownerRecords.length !== records.length) {
    throw new Error('Cleanup tail contains unexpected transaction artifacts');
  }
  const physical = new Set(ownerRecords.flatMap(quarantineArtifactNames));
  const unexpected = entries.filter(
    (entry) =>
      entry !== TRANSACTION_OWNER &&
      !physical.has(entry) &&
      !isQuarantineDraftName(entry),
  );
  if (unexpected.length > 0) {
    throw new Error('Cleanup tail contains unexpected transaction artifacts');
  }
  await optionalOwner(root, transaction, cleanup.id);
  await removeOwnedTransactionDurably({
    allowed: new Set([TRANSACTION_OWNER]),
    decision: cleanup.decision,
    id: cleanup.id,
    reservedName,
    root: rootDirectory,
    transaction,
    validate: () => optionalOwner(root, transaction, cleanup.id),
  });
};
