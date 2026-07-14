import {
  openPinnedChild,
  type PinnedDirectory,
} from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import { scavengeDurableCleanup } from './sync-transaction-cleanup';
import { openRemovalBindingDirectory } from './sync-transaction-quarantine-read';
import type { TransactionReservation } from './sync-transaction-reservation';
import { reservationIdentity } from './sync-transaction-reservation-record';
import { TRANSACTION_CLEANUP } from './sync-transaction-types';

const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

export const hasCompletedCleanup = async (
  root: PinnedDirectory,
): Promise<boolean> => {
  try {
    const cleanup = await openPinnedChild(root, TRANSACTION_CLEANUP);
    await cleanup.handle.close();
    return true;
  } catch (error) {
    if (missing(error)) {
      return false;
    }
    throw error;
  }
};

export const scavengeCompletedCleanup = async (
  root: RepositoryRoot,
  rootDirectory: PinnedDirectory,
  reservation: TransactionReservation,
): Promise<void> => {
  let cleanup: PinnedDirectory;
  try {
    cleanup = await openPinnedChild(rootDirectory, TRANSACTION_CLEANUP);
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }
    const bound = await openRemovalBindingDirectory(
      rootDirectory,
      TRANSACTION_CLEANUP,
      reservation.phase === 'cleanup'
        ? reservationIdentity(reservation.transaction, 'transaction')
        : undefined,
    );
    if (bound === null) {
      throw error;
    }
    cleanup = bound;
  }
  try {
    await scavengeDurableCleanup({
      reservation,
      reservedName: TRANSACTION_CLEANUP,
      root,
      rootDirectory,
      transaction: cleanup,
    });
  } finally {
    await cleanup.handle.close();
  }
};
