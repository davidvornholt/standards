import type { PinnedDirectory } from './sync-directory-handles';
import { removeOwnedTransaction } from './sync-transaction-artifact-cleanup';
import {
  isUnpublishedTransaction,
  unpublishedArtifactNames,
} from './sync-transaction-artifact-policy';
import {
  assertNoUnboundAtomicPublicationTails,
  removeBoundAtomicPartialTails,
} from './sync-transaction-atomic-recovery';
import { removeOwnedTransactionDurably } from './sync-transaction-durable-cleanup';
import {
  findOwnerPublicationToken,
  type OwnerPublicationToken,
} from './sync-transaction-owner-reservation';
import { removeOwnerPublicationToken } from './sync-transaction-owner-token-cleanup';
import {
  assertTransactionOwner,
  readTransactionOwner,
  type TransactionOwner,
} from './sync-transaction-ownership';
import type { PublicationRecoveryInput } from './sync-transaction-publication-types';
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
  cleanupId: string,
): Promise<void> => {
  if (reservationId === null) {
    await removeOwnedTransactionDurably({
      allowed: unpublishedArtifactNames,
      decision: 'rolled-back',
      id: cleanupId,
      reservedName: TRANSACTION_DIRECTORY,
      root,
      transaction,
    });
    return;
  }
  await removeOwnedTransaction({
    allowed: unpublishedArtifactNames,
    reservedName: TRANSACTION_DIRECTORY,
    root,
    transaction,
  });
  await removeTransactionReservation(root, reservationId);
};

const removeEmptyUnboundPublication = async (
  root: PinnedDirectory,
  transaction: PinnedDirectory,
  reservationId: string,
): Promise<void> => {
  await removeOwnedTransaction({
    allowed: new Set(),
    reservedName: TRANSACTION_DIRECTORY,
    root,
    transaction,
  });
  await removeTransactionReservation(root, reservationId);
};

const recoverWithOwnerToken = async (
  input: PublicationRecoveryInput,
  ownerToken: OwnerPublicationToken,
): Promise<TransactionOwner | null> => {
  const { reservation, root, rootDirectory, transaction } = input;
  if (reservation !== null && ownerToken.id !== reservation.id) {
    throw new Error('Filesystem publication ownership records disagree');
  }
  await removeBoundAtomicPartialTails(
    transaction,
    TRANSACTION_OWNER,
    ownerToken.ownerRecord,
  );
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
      ownerToken.id,
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
    await removeEmptyUnboundPublication(
      rootDirectory,
      transaction,
      reservation.id,
    );
    return null;
  }
  assertTransactionOwner(owner, root.identity, transaction);
  if (owner.id !== reservation.id) {
    throw new Error('Transaction owner does not match its reservation');
  }
  if (await isUnpublishedTransaction(transaction)) {
    await removeUnpublished(
      rootDirectory,
      transaction,
      reservation.id,
      reservation.id,
    );
    return null;
  }
  await removeTransactionReservation(rootDirectory, reservation.id);
  return owner;
};

const recoverWithoutReservation = async (
  input: PublicationRecoveryInput,
): Promise<TransactionOwner | null> => {
  const { root, rootDirectory, transaction } = input;
  await assertNoUnboundAtomicPublicationTails(transaction, TRANSACTION_OWNER);
  const owner = await readTransactionOwner(transaction);
  assertTransactionOwner(owner, root.identity, transaction);
  if (await isUnpublishedTransaction(transaction)) {
    await removeUnpublished(rootDirectory, transaction, null, owner.id);
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
