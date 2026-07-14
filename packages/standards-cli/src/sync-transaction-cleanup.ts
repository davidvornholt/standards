import { readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import { journalArtifactNames } from './sync-transaction-artifact-policy';
import { assertTransactionArtifacts } from './sync-transaction-artifact-validation';
import { findRemovalBinding } from './sync-transaction-bound-remove';
import { removeOwnedTransactionDurably } from './sync-transaction-durable-cleanup';
import { readJournal } from './sync-transaction-journal';
import {
  assertTransactionOwner,
  readTransactionOwner,
} from './sync-transaction-ownership';
import { finishCreatedParents } from './sync-transaction-parents';
import {
  assertCleanupReservation,
  type CleanupReservation,
  type TransactionReservation,
} from './sync-transaction-reservation';
import {
  TRANSACTION_DIRECTORY,
  TRANSACTION_JOURNAL,
  TRANSACTION_OWNER,
  type TransactionJournal,
} from './sync-transaction-types';

const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

const assertOwnedTransaction = async (
  root: RepositoryRoot,
  transaction: PinnedDirectory,
  journalId: string,
): Promise<void> => {
  const owner = await readTransactionOwner(transaction);
  assertTransactionOwner(owner, root.identity, transaction);
  if (owner.id !== journalId) {
    throw new Error('Transaction owner does not match its journal');
  }
};

const optionalOwner = async (
  root: RepositoryRoot,
  transaction: PinnedDirectory,
  id: string,
): Promise<void> => {
  try {
    await assertOwnedTransaction(root, transaction, id);
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }
  }
};

export const scavengeDurableCleanup = async ({
  reservation,
  reservedName,
  root,
  rootDirectory,
  transaction,
}: {
  readonly reservation: TransactionReservation;
  readonly reservedName: CleanupReservation['reservedName'];
  readonly root: RepositoryRoot;
  readonly rootDirectory: PinnedDirectory;
  readonly transaction: PinnedDirectory;
}): Promise<void> => {
  const ownership = {
    id: reservation.id,
    reservation,
    reservedName,
    root: root.identity,
    transaction,
  };
  assertCleanupReservation(ownership);
  const cleanupReservation = ownership.reservation;
  const entries = await readdir(directoryEntryPath(transaction, '.'));
  if (
    entries.includes(TRANSACTION_JOURNAL) ||
    (await findRemovalBinding(transaction, TRANSACTION_JOURNAL)) !== null
  ) {
    const journal = await readJournal(transaction);
    if (journal.id !== cleanupReservation.id) {
      throw new Error('Cleanup reservation does not match its journal');
    }
    await assertOwnedTransaction(root, transaction, journal.id);
    await assertTransactionArtifacts({
      committed: cleanupReservation.decision === 'committed',
      journal,
      root,
      transaction,
    });
    await removeOwnedTransactionDurably({
      allowed: journalArtifactNames(
        journal,
        cleanupReservation.decision === 'committed',
      ),
      decision: cleanupReservation.decision,
      id: cleanupReservation.id,
      reservedName,
      root: rootDirectory,
      transaction,
      validate: () =>
        assertTransactionArtifacts({
          committed: cleanupReservation.decision === 'committed',
          journal,
          root,
          transaction,
        }),
    });
    return;
  }
  const ownerBinding = await findRemovalBinding(transaction, TRANSACTION_OWNER);
  const unexpected = entries.filter(
    (entry) => entry !== TRANSACTION_OWNER && entry !== ownerBinding?.name,
  );
  if (unexpected.length > 0) {
    throw new Error('Cleanup tail contains unexpected transaction artifacts');
  }
  await optionalOwner(root, transaction, cleanupReservation.id);
  await removeOwnedTransactionDurably({
    allowed: new Set([TRANSACTION_OWNER]),
    decision: cleanupReservation.decision,
    id: cleanupReservation.id,
    reservedName,
    root: rootDirectory,
    transaction,
    validate: () => optionalOwner(root, transaction, cleanupReservation.id),
  });
};

export const cleanupTransaction = async ({
  afterArtifactUnlink,
  afterRemoval,
  afterReservationPartialWrite,
  beforeRename,
  beforeRmdir,
  committed,
  fault,
  journal,
  root,
  rootDirectory,
  transaction,
}: {
  readonly afterArtifactUnlink?: (name: string) => Promise<void>;
  readonly afterRemoval?: () => Promise<void>;
  readonly afterReservationPartialWrite?: () => Promise<void>;
  readonly beforeRename?: () => Promise<void>;
  readonly beforeRmdir?: () => Promise<void>;
  readonly committed: boolean;
  readonly fault: import('./sync-transaction-types').MutationFault;
  readonly journal: TransactionJournal;
  readonly root: RepositoryRoot;
  readonly rootDirectory: PinnedDirectory;
  readonly transaction: PinnedDirectory;
}): Promise<ReadonlyArray<unknown>> => {
  let errors: Array<unknown> = [];
  try {
    await assertOwnedTransaction(root, transaction, journal.id);
    await assertTransactionArtifacts({ committed, journal, root, transaction });
  } catch (error) {
    return [error];
  }
  errors = await finishCreatedParents({
    committed,
    fault,
    journal,
    root,
    rootDirectory,
  });
  if (errors.length > 0) {
    return errors;
  }
  try {
    await removeOwnedTransactionDurably({
      afterReservationPartialWrite,
      afterUnlink: afterArtifactUnlink,
      allowed: journalArtifactNames(journal, committed),
      beforeRmdir,
      beforeUnlink: beforeRename,
      decision: committed ? 'committed' : 'rolled-back',
      id: journal.id,
      reservedName: TRANSACTION_DIRECTORY,
      root: rootDirectory,
      transaction,
      validate: () =>
        assertTransactionArtifacts({ committed, journal, root, transaction }),
    });
    await afterRemoval?.();
  } catch (error) {
    errors.push(error);
  }
  return errors;
};
