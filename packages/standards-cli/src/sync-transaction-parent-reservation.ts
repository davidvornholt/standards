import type { PinnedDirectory } from './sync-directory-handles';
import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import { publishAtomicTransactionRecord } from './sync-transaction-atomic-record';
import {
  type ParentCleanupReservation,
  RESERVATION_VERSION,
  reservationIdentity,
  reservationMatches,
  storedIdentity,
  type TransactionReservation,
} from './sync-transaction-reservation-record';
import { TRANSACTION_RESERVATION } from './sync-transaction-types';

export type ParentReservationHooks = {
  readonly afterFinalSync?: () => Promise<void>;
  readonly afterPartialWrite?: () => Promise<void>;
};

export const createParentCleanupReservation = async ({
  decision,
  hooks = {},
  id,
  parent,
  rel,
  root,
}: {
  readonly decision: ParentCleanupReservation['decision'];
  readonly hooks?: ParentReservationHooks;
  readonly id: string;
  readonly parent: PinnedDirectory;
  readonly rel: string;
  readonly root: PinnedDirectory;
}): Promise<ParentCleanupReservation> => {
  const reservation: ParentCleanupReservation = {
    decision,
    id,
    parent: storedIdentity(parent.identity),
    phase: 'parent-cleanup',
    rel,
    root: storedIdentity(root.identity),
    version: RESERVATION_VERSION,
  };
  await publishAtomicTransactionRecord({
    afterFinalSync: hooks.afterFinalSync,
    afterPartialWrite: hooks.afterPartialWrite,
    contents: `${JSON.stringify(reservation)}\n`,
    directory: root,
    finalName: TRANSACTION_RESERVATION,
    maximumBytes: 8192,
  });
  return reservation;
};

type ParentReservationValues = {
  readonly id: string;
  readonly parent: PinnedDirectory;
  readonly rel: string;
  readonly reservation: TransactionReservation;
  readonly root: NodeIdentity;
};

type AssertParentCleanupReservation = (
  values: ParentReservationValues,
) => asserts values is ParentReservationValues & {
  readonly reservation: ParentCleanupReservation;
};

export const assertParentCleanupReservation: AssertParentCleanupReservation = (
  values,
) => {
  const { id, parent, rel, reservation, root } = values;
  if (
    !reservationMatches(reservation, root, id) ||
    reservation.phase !== 'parent-cleanup' ||
    reservation.rel !== rel ||
    !identitiesMatch(
      parent.identity,
      reservationIdentity(reservation.parent, 'parent'),
    )
  ) {
    throw new Error('Created-parent cleanup reservation does not match');
  }
};
