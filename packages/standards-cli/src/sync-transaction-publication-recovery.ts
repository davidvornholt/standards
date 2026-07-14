import type { PinnedDirectory } from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import { recoverAtomicPublicationTails } from './sync-transaction-atomic-recovery';
import type { TransactionOwner } from './sync-transaction-ownership';
import { recoverPublicationCase } from './sync-transaction-publication-cases';
import {
  assertTransactionReservation,
  readTransactionReservation,
  removeTransactionReservation,
  reservationMissing,
  type TransactionReservation,
} from './sync-transaction-reservation';
import { TRANSACTION_RESERVATION } from './sync-transaction-types';

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
