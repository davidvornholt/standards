import {
  openPinnedChild,
  type PinnedDirectory,
} from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import { scavengeDurableCleanup } from './sync-transaction-cleanup';
import {
  hasCompletedCleanup,
  scavengeCompletedCleanup,
} from './sync-transaction-cleanup-state';
import { removeOrphanOwnerPublicationToken } from './sync-transaction-owner-reservation';
import {
  optionalTransactionReservation,
  recoverMissingTransaction,
} from './sync-transaction-publication-recovery';
import type { TransactionReservation } from './sync-transaction-reservation';
import { TRANSACTION_DIRECTORY } from './sync-transaction-types';

const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

const openTransaction = async (
  root: PinnedDirectory,
): Promise<PinnedDirectory | null> => {
  try {
    return await openPinnedChild(root, TRANSACTION_DIRECTORY);
  } catch (error) {
    if (missing(error)) {
      return null;
    }
    throw error;
  }
};

type PendingTransaction = {
  readonly done: false;
  readonly reservation: TransactionReservation | null;
  readonly transaction: PinnedDirectory;
};

export const prepareRecoveryState = async ({
  mutate,
  opened,
  root,
  rootDirectory,
}: {
  readonly mutate: boolean;
  readonly opened: Array<PinnedDirectory>;
  readonly root: RepositoryRoot;
  readonly rootDirectory: PinnedDirectory;
}): Promise<PendingTransaction | { readonly done: true }> => {
  let reservation = await optionalTransactionReservation(rootDirectory, mutate);
  if (await hasCompletedCleanup(rootDirectory)) {
    if (!mutate) {
      throw new Error('Pending committed transaction cleanup');
    }
    if (reservation === null) {
      throw new Error('Cleanup directory has no durable cleanup reservation');
    }
    await scavengeCompletedCleanup(root, rootDirectory, reservation);
    reservation = null;
  } else if (
    reservation?.phase === 'cleanup' &&
    reservation.reservedName !== TRANSACTION_DIRECTORY
  ) {
    await recoverMissingTransaction({
      mutate,
      reservation,
      root,
      rootDirectory,
    });
    reservation = null;
  }
  const transaction = await openTransaction(rootDirectory);
  if (transaction === null) {
    await removeOrphanOwnerPublicationToken(
      rootDirectory,
      reservation?.id,
      mutate,
    );
    await recoverMissingTransaction({
      mutate,
      reservation,
      root,
      rootDirectory,
    });
    return { done: true };
  }
  opened.push(transaction);
  if (!mutate) {
    throw new Error(`Pending filesystem recovery: ${TRANSACTION_DIRECTORY}`);
  }
  if (reservation?.phase === 'cleanup') {
    await scavengeDurableCleanup({
      reservation,
      reservedName: TRANSACTION_DIRECTORY,
      root,
      rootDirectory,
      transaction,
    });
    return { done: true };
  }
  return { done: false, reservation, transaction };
};
