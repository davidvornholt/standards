import {
  openPinnedChild,
  type PinnedDirectory,
} from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import { scavengeDurableCleanup } from './sync-transaction-cleanup';
import type { TransactionReservation } from './sync-transaction-reservation';
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
  const cleanup = await openPinnedChild(rootDirectory, TRANSACTION_CLEANUP);
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
