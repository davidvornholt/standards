import type { PinnedDirectory } from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import {
  isUnpublishedTransaction,
  removeOwnedTransaction,
  unpublishedArtifactNames,
} from './sync-transaction-artifact-cleanup';
import {
  recoverAtomicPublicationTails,
  removeBoundAtomicPartialTails,
} from './sync-transaction-atomic-recovery';
import {
  findOwnerPublicationToken,
  type OwnerPublicationToken,
  removeOwnerPublicationToken,
} from './sync-transaction-owner-reservation';
import {
  assertTransactionOwner,
  readTransactionOwner,
  type TransactionOwner,
} from './sync-transaction-ownership';
import {
  assertTransactionReservation,
  removeTransactionReservation,
  type TransactionReservation,
} from './sync-transaction-reservation';
import {
  TRANSACTION_DIRECTORY,
  TRANSACTION_OWNER,
} from './sync-transaction-types';

const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

const optionalOwner = async (
  transaction: PinnedDirectory,
): Promise<TransactionOwner | null> => {
  await recoverAtomicPublicationTails(transaction, TRANSACTION_OWNER);
  try {
    return await readTransactionOwner(transaction);
  } catch (error) {
    if (missing(error)) {
      return null;
    }
    throw error;
  }
};

const removeUnpublished = async (
  root: PinnedDirectory,
  transaction: PinnedDirectory,
  reservationId: string | null,
): Promise<void> => {
  await removeOwnedTransaction({
    allowed: unpublishedArtifactNames,
    reservedName: TRANSACTION_DIRECTORY,
    root,
    transaction,
  });
  if (reservationId !== null) {
    await removeTransactionReservation(root, reservationId);
  }
};

export type PublicationRecoveryInput = {
  readonly reservation: TransactionReservation | null;
  readonly root: RepositoryRoot;
  readonly rootDirectory: PinnedDirectory;
  readonly transaction: PinnedDirectory;
};

const recoverWithOwnerToken = async (
  input: PublicationRecoveryInput,
  ownerToken: OwnerPublicationToken,
): Promise<TransactionOwner | null> => {
  const { reservation, root, rootDirectory, transaction } = input;
  if (reservation !== null && ownerToken.id !== reservation.id) {
    throw new Error('Filesystem publication ownership records disagree');
  }
  await removeBoundAtomicPartialTails(transaction, TRANSACTION_OWNER);
  const owner = await optionalOwner(transaction);
  if (owner !== null) {
    assertTransactionOwner(owner, root.identity, transaction);
    if (owner.id !== ownerToken.id) {
      throw new Error('Owner publication token has a different owner');
    }
  }
  if (owner === null || (await isUnpublishedTransaction(transaction))) {
    await removeUnpublished(
      rootDirectory,
      transaction,
      reservation?.phase === 'publication' ? reservation.id : null,
    );
    await removeOwnerPublicationToken(rootDirectory, ownerToken);
    return null;
  }
  await removeOwnerPublicationToken(rootDirectory, ownerToken);
  return owner;
};

const recoverWithReservation = async (
  input: PublicationRecoveryInput,
  reservation: TransactionReservation,
): Promise<TransactionOwner | null> => {
  const { root, rootDirectory, transaction } = input;
  assertTransactionReservation(reservation, root.identity);
  const owner = await optionalOwner(transaction);
  if (reservation.phase === 'parent-cleanup') {
    if (owner === null) {
      throw new Error('Parent cleanup reservation has no transaction owner');
    }
    assertTransactionOwner(owner, root.identity, transaction);
    if (owner.id !== reservation.id) {
      throw new Error('Parent cleanup reservation has a different owner');
    }
    return owner;
  }
  if (reservation.phase !== 'publication') {
    throw new Error('Cleanup reservation reached publication recovery');
  }
  if (owner === null) {
    throw new Error('Reserved transaction has no inode-bound owner');
  }
  assertTransactionOwner(owner, root.identity, transaction);
  if (owner.id !== reservation.id) {
    throw new Error('Transaction owner does not match its reservation');
  }
  if (await isUnpublishedTransaction(transaction)) {
    await removeUnpublished(rootDirectory, transaction, reservation.id);
    return null;
  }
  await removeTransactionReservation(rootDirectory, reservation.id);
  return owner;
};

const recoverWithoutReservation = async (
  input: PublicationRecoveryInput,
): Promise<TransactionOwner | null> => {
  const { root, rootDirectory, transaction } = input;
  await recoverAtomicPublicationTails(transaction, TRANSACTION_OWNER);
  const owner = await readTransactionOwner(transaction);
  assertTransactionOwner(owner, root.identity, transaction);
  if (await isUnpublishedTransaction(transaction)) {
    await removeUnpublished(rootDirectory, transaction, null);
    return null;
  }
  return owner;
};

export const recoverPublicationCase = async (
  input: PublicationRecoveryInput,
): Promise<TransactionOwner | null> => {
  const ownerToken = await findOwnerPublicationToken(
    input.rootDirectory,
    input.transaction,
  );
  if (ownerToken !== null) {
    return recoverWithOwnerToken(input, ownerToken);
  }
  if (input.reservation !== null) {
    return recoverWithReservation(input, input.reservation);
  }
  return recoverWithoutReservation(input);
};
