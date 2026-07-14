import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import { readQuarantineRecords } from './sync-transaction-quarantine-record';
import { quarantineEntryName } from './sync-transaction-quarantine-schema';
import {
  parseReservation,
  reservationMatches,
} from './sync-transaction-reservation-record';
import { TRANSACTION_RESERVATION } from './sync-transaction-types';

const retainedReservationMatches = async (
  root: PinnedDirectory,
  name: string,
  expectedId: string,
): Promise<boolean> => {
  const handle = await open(
    directoryEntryPath(root, name),
    constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  );
  try {
    const reservation = parseReservation(await handle.readFile('utf8'));
    return reservationMatches(reservation, root.identity, expectedId);
  } finally {
    await handle.close();
  }
};

export const hasRemovedTransactionReservation = async (
  root: PinnedDirectory,
  expectedId: string,
): Promise<boolean> => {
  const records = (await readQuarantineRecords(root)).filter(
    ({ kind, original }) =>
      original === TRANSACTION_RESERVATION && kind === 'file',
  );
  const matches = await Promise.all(
    records.map((record) =>
      retainedReservationMatches(root, quarantineEntryName(record), expectedId),
    ),
  );
  return matches.some(Boolean);
};
