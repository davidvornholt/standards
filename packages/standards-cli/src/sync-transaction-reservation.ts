import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch } from './sync-filesystem';
import { isMissingFilesystemError } from './sync-filesystem-error';
import type { NodeIdentity } from './sync-node-identity';
import { publishAtomicTransactionRecord } from './sync-transaction-atomic-record';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';
import { hasRemovedTransactionReservation } from './sync-transaction-reservation-quarantine';
import {
  type CleanupReservation,
  type PublicationReservation,
  parseReservation,
  RESERVATION_VERSION,
  reservationIdentity,
  reservationMatches,
  storedIdentity,
  type TransactionReservation,
} from './sync-transaction-reservation-record';
import { TRANSACTION_RESERVATION } from './sync-transaction-types';

export type {
  CleanupReservation,
  ParentCleanupReservation,
  PublicationReservation,
  TransactionReservation,
} from './sync-transaction-reservation-record';

const MAX_BYTES = 8192;

export const readTransactionReservationEntry = async (
  root: PinnedDirectory,
) => {
  const handle = await open(
    directoryEntryPath(root, TRANSACTION_RESERVATION),
    constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat({ bigint: true });
    if (!(info.isFile() && info.size <= BigInt(MAX_BYTES))) {
      throw new Error('Transaction reservation must be a small regular file');
    }
    return {
      identity: { dev: info.dev, ino: info.ino },
      reservation: parseReservation(await handle.readFile('utf8')),
    };
  } finally {
    await handle.close();
  }
};

export const readTransactionReservation = async (
  root: PinnedDirectory,
): Promise<TransactionReservation> =>
  (await readTransactionReservationEntry(root)).reservation;

export const assertTransactionReservation = (
  reservation: TransactionReservation,
  root: NodeIdentity,
  id?: string,
): void => {
  if (!reservationMatches(reservation, root, id)) {
    throw new Error('Transaction reservation does not match its repository');
  }
};

type PublicationHooks = {
  readonly afterFinalSync?: () => Promise<void>;
  readonly afterPartialWrite?: () => Promise<void>;
};

const publishReservation = async (
  root: PinnedDirectory,
  reservation: TransactionReservation,
  hooks: PublicationHooks = {},
): Promise<void> =>
  publishAtomicTransactionRecord({
    afterFinalSync: hooks.afterFinalSync,
    afterPartialWrite: hooks.afterPartialWrite,
    contents: `${JSON.stringify(reservation)}\n`,
    directory: root,
    finalName: TRANSACTION_RESERVATION,
    maximumBytes: MAX_BYTES,
  });

export const createTransactionReservation = async (
  root: PinnedDirectory,
  id: string,
  hooks: PublicationHooks = {},
): Promise<PublicationReservation> => {
  const reservation: PublicationReservation = {
    id,
    phase: 'publication',
    root: storedIdentity(root.identity),
    version: RESERVATION_VERSION,
  };
  await publishReservation(root, reservation, hooks);
  return reservation;
};

export const createCleanupReservation = async ({
  decision,
  id,
  hooks = {},
  reservedName,
  root,
  transaction,
}: {
  readonly decision: CleanupReservation['decision'];
  readonly id: string;
  readonly hooks?: PublicationHooks;
  readonly reservedName: CleanupReservation['reservedName'];
  readonly root: PinnedDirectory;
  readonly transaction: PinnedDirectory;
}): Promise<CleanupReservation> => {
  const reservation: CleanupReservation = {
    decision,
    id,
    phase: 'cleanup',
    reservedName,
    root: storedIdentity(root.identity),
    transaction: storedIdentity(transaction.identity),
    version: RESERVATION_VERSION,
  };
  await publishReservation(root, reservation, hooks);
  return reservation;
};

type AssertCleanupReservation = (values: {
  readonly id: string;
  readonly reservation: TransactionReservation;
  readonly reservedName: CleanupReservation['reservedName'];
  readonly root: NodeIdentity;
  readonly transaction: PinnedDirectory;
}) => asserts values is {
  readonly id: string;
  readonly reservation: CleanupReservation;
  readonly reservedName: CleanupReservation['reservedName'];
  readonly root: NodeIdentity;
  readonly transaction: PinnedDirectory;
};

export const assertCleanupReservation: AssertCleanupReservation = (values) => {
  const { id, reservation, reservedName, root, transaction } = values;
  assertTransactionReservation(reservation, root, id);
  if (
    reservation.phase !== 'cleanup' ||
    reservation.reservedName !== reservedName ||
    !identitiesMatch(
      transaction.identity,
      reservationIdentity(reservation.transaction, 'transaction'),
    )
  ) {
    throw new Error('Transaction cleanup reservation does not match its owner');
  }
};

export const removeTransactionReservation = async (
  root: PinnedDirectory,
  expectedId: string,
  hooks: {
    readonly afterSync?: () => Promise<void>;
    readonly afterBind?: () => Promise<void>;
    readonly afterUnlink?: () => Promise<void>;
  } = {},
): Promise<void> => {
  let before: Awaited<ReturnType<typeof readTransactionReservationEntry>>;
  try {
    before = await readTransactionReservationEntry(root);
  } catch (error) {
    if (!isMissingFilesystemError(error)) {
      throw error;
    }
    if (await hasRemovedTransactionReservation(root, expectedId)) {
      return;
    }
    throw error;
  }
  assertTransactionReservation(before.reservation, root.identity, expectedId);
  const after = await readTransactionReservationEntry(root);
  if (!identitiesMatch(before.identity, after.identity)) {
    throw new Error('Transaction reservation changed during cleanup');
  }
  await bindAndRemoveEntry({
    afterBind: hooks.afterBind,
    directory: root,
    expected: after.identity,
    kind: 'file',
    name: TRANSACTION_RESERVATION,
  });
  await hooks.afterUnlink?.();
  await syncPinnedDirectory(root);
  await hooks.afterSync?.();
};
