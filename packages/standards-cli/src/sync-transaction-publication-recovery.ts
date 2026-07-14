import {
  openPinnedChild,
  type PinnedDirectory,
} from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import { removeOwnedTransaction } from './sync-transaction-artifact-cleanup';
import {
  transactionPublicationId,
  transactionPublicationName,
} from './sync-transaction-artifact-names';
import { unpublishedArtifactNames } from './sync-transaction-artifact-policy';
import { recoverAtomicPublicationTails } from './sync-transaction-atomic-recovery';
import { openRemovalBindingDirectory } from './sync-transaction-bound-remove';
import { findOwnerPublicationToken } from './sync-transaction-owner-reservation';
import { removeOwnerPublicationToken } from './sync-transaction-owner-token-cleanup';
import type { TransactionOwner } from './sync-transaction-ownership';
import { recoverPublicationCase } from './sync-transaction-publication-cases';
import { stagedTransactionPublicationNames } from './sync-transaction-publication-namespace';
import {
  assertTransactionReservation,
  readTransactionReservation,
  removeTransactionReservation,
  reservationMissing,
  type TransactionReservation,
} from './sync-transaction-reservation';
import { TRANSACTION_RESERVATION } from './sync-transaction-types';

const recoverBoundStagedRemoval = async (
  root: PinnedDirectory,
  reservation: TransactionReservation | null,
): Promise<boolean> => {
  if (reservation?.phase !== 'publication') {
    return false;
  }
  const name = transactionPublicationName(reservation.id);
  const transaction = await openRemovalBindingDirectory(root, name);
  if (transaction === null) {
    return false;
  }
  try {
    const token = await findOwnerPublicationToken(root, transaction);
    await removeOwnedTransaction({
      allowed: unpublishedArtifactNames,
      reservedName: name,
      root,
      transaction,
    });
    if (token !== null) {
      await removeOwnerPublicationToken(root, token);
    }
    await removeTransactionReservation(root, reservation.id);
    return true;
  } finally {
    await transaction.handle.close();
  }
};

export const recoverStagedTransactionPublication = async ({
  mutate,
  reservation,
  root,
}: {
  readonly mutate: boolean;
  readonly reservation: TransactionReservation | null;
  readonly root: PinnedDirectory;
}): Promise<TransactionReservation | null> => {
  const entries = await stagedTransactionPublicationNames(root);
  if (entries.length === 0) {
    if (await recoverBoundStagedRemoval(root, reservation)) {
      return null;
    }
    return reservation;
  }
  if (entries.length !== 1) {
    throw new Error('Repository has multiple staged transaction publications');
  }
  const name = entries[0] as string;
  const id = transactionPublicationId(name);
  if (
    id === null ||
    reservation === null ||
    reservation.phase !== 'publication' ||
    reservation.id !== id
  ) {
    throw new Error(
      'Staged transaction publication has no matching reservation',
    );
  }
  if (!mutate) {
    throw new Error('Pending staged transaction publication cleanup');
  }
  assertTransactionReservation(reservation, root.identity, id);
  const transaction = await openPinnedChild(root, name);
  try {
    const token = await findOwnerPublicationToken(root, transaction);
    if (token === null) {
      throw new Error('Staged transaction publication is not inode-bound');
    }
    if (token.id !== id) {
      throw new Error('Staged transaction publication token has another owner');
    }
    await removeOwnedTransaction({
      allowed: unpublishedArtifactNames,
      reservedName: name,
      root,
      transaction,
    });
    await removeOwnerPublicationToken(root, token);
    await removeTransactionReservation(root, id);
    return null;
  } finally {
    await transaction.handle.close();
  }
};

export const optionalTransactionReservation = async (
  root: PinnedDirectory,
  mutate = true,
): Promise<TransactionReservation | null> => {
  await recoverAtomicPublicationTails(root, TRANSACTION_RESERVATION, mutate);
  try {
    return await readTransactionReservation(root);
  } catch (error) {
    if (reservationMissing(error)) {
      return null;
    }
    throw error;
  }
};

export const recoverMissingTransaction = async ({
  mutate,
  reservation,
  root,
  rootDirectory,
}: {
  readonly mutate: boolean;
  readonly reservation: TransactionReservation | null;
  readonly root: RepositoryRoot;
  readonly rootDirectory: PinnedDirectory;
}): Promise<void> => {
  if (reservation === null) {
    return;
  }
  if (!mutate) {
    throw new Error('Pending filesystem transaction reservation');
  }
  assertTransactionReservation(reservation, root.identity);
  await removeTransactionReservation(rootDirectory, reservation.id);
};

export const recoverTransactionPublication = async ({
  reservation,
  root,
  rootDirectory,
  transaction,
}: {
  readonly reservation: TransactionReservation | null;
  readonly root: RepositoryRoot;
  readonly rootDirectory: PinnedDirectory;
  readonly transaction: PinnedDirectory;
}): Promise<TransactionOwner | null> =>
  recoverPublicationCase({ reservation, root, rootDirectory, transaction });
