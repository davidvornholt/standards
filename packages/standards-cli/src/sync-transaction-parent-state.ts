import { constants } from 'node:fs';
import { type FileHandle, open, readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import {
  assertTransactionReservation,
  type ParentCleanupReservation,
  readTransactionReservation,
  reservationMissing,
  type TransactionReservation,
} from './sync-transaction-reservation';
import type { TransactionJournal } from './sync-transaction-types';

const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

export const createdParentMarkerName = (id: string): string =>
  `.standards-parent-${id}`;

export const verifyCreatedParentMarker = async (
  directory: PinnedDirectory,
  journal: TransactionJournal,
): Promise<boolean> => {
  let marker: FileHandle;
  try {
    marker = await open(
      directoryEntryPath(directory, createdParentMarkerName(journal.id)),
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
    );
  } catch (error) {
    if (missing(error)) {
      return false;
    }
    throw error;
  }
  try {
    const info = await marker.stat();
    if (
      !(info.isFile() && info.size === journal.id.length) ||
      (await marker.readFile('utf8')) !== journal.id
    ) {
      throw new Error('Created-parent ownership marker is invalid');
    }
    return true;
  } finally {
    await marker.close();
  }
};

export const readParentCleanupReservation = async (
  root: PinnedDirectory,
  journal: TransactionJournal,
  rel: string,
): Promise<ParentCleanupReservation | null> => {
  let reservation: TransactionReservation;
  try {
    reservation = await readTransactionReservation(root);
  } catch (error) {
    if (reservationMissing(error)) {
      return null;
    }
    throw error;
  }
  assertTransactionReservation(reservation, root.identity, journal.id);
  if (reservation.phase !== 'parent-cleanup' || reservation.rel !== rel) {
    throw new Error('Created-parent cleanup reservation is inconsistent');
  }
  return reservation;
};

export const assertOnlyCreatedParentMarker = async (
  directory: PinnedDirectory,
  marker: string,
): Promise<void> => {
  const unexpected = (await readdir(directoryEntryPath(directory, '.'))).filter(
    (entry) => entry !== marker,
  );
  if (unexpected.length > 0) {
    throw new Error('Created parent contains unexpected descendants');
  }
};
