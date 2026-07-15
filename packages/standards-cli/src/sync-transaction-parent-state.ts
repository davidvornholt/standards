import { constants } from 'node:fs';
import { type FileHandle, open, readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import { identityOf } from './sync-filesystem';
import { isMissingFilesystemError } from './sync-filesystem-error';
import type { NodeIdentity } from './sync-node-identity';
import { resolveRemovalEntryName } from './sync-transaction-quarantine-read';
import {
  assertTransactionReservation,
  type ParentCleanupReservation,
  readTransactionReservation,
  type TransactionReservation,
} from './sync-transaction-reservation';
import type { TransactionJournal } from './sync-transaction-types';

export const createdParentMarkerName = (id: string): string =>
  `.standards-parent-${id}`;

export const createdParentMarkerIdentity = async (
  directory: PinnedDirectory,
  journal: TransactionJournal,
): Promise<NodeIdentity | null> => {
  const name = createdParentMarkerName(journal.id);
  let marker: FileHandle;
  try {
    marker = await open(
      directoryEntryPath(
        directory,
        await resolveRemovalEntryName(directory, name),
      ),
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      return null;
    }
    throw error;
  }
  try {
    const info = await marker.stat({ bigint: true });
    if (
      !(info.isFile() && info.size === BigInt(journal.id.length)) ||
      (await marker.readFile('utf8')) !== journal.id
    ) {
      throw new Error('Created-parent ownership marker is invalid');
    }
    return identityOf(info);
  } finally {
    await marker.close();
  }
};

export const verifyCreatedParentMarker = async (
  directory: PinnedDirectory,
  journal: TransactionJournal,
): Promise<boolean> =>
  (await createdParentMarkerIdentity(directory, journal)) !== null;

export const readParentCleanupReservation = async (
  root: PinnedDirectory,
  journal: TransactionJournal,
  rel: string,
): Promise<ParentCleanupReservation | null> => {
  let reservation: TransactionReservation;
  try {
    reservation = await readTransactionReservation(root);
  } catch (error) {
    if (isMissingFilesystemError(error)) {
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
