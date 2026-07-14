import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import {
  TRANSACTION_CLEANUP,
  TRANSACTION_DIRECTORY,
} from './sync-transaction-types';

export const RESERVATION_VERSION = 1;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL = /^\d+$/u;

type StoredIdentity = { readonly dev: string; readonly ino: string };
type ReservationBase = {
  readonly id: string;
  readonly root: StoredIdentity;
  readonly version: typeof RESERVATION_VERSION;
};

export type PublicationReservation = ReservationBase & {
  readonly phase: 'publication';
};

export type ParentCleanupReservation = ReservationBase & {
  readonly decision: 'committed' | 'rolled-back';
  readonly parent: StoredIdentity;
  readonly phase: 'parent-cleanup';
  readonly rel: string;
};

export type CleanupReservation = ReservationBase & {
  readonly decision: 'committed' | 'rolled-back';
  readonly phase: 'cleanup';
  readonly reservedName:
    | typeof TRANSACTION_CLEANUP
    | typeof TRANSACTION_DIRECTORY;
  readonly transaction: StoredIdentity;
};

export type TransactionReservation =
  | CleanupReservation
  | ParentCleanupReservation
  | PublicationReservation;

export const storedIdentity = (value: NodeIdentity): StoredIdentity => ({
  dev: String(value.dev),
  ino: String(value.ino),
});

export const reservationIdentity = (
  value: unknown,
  label: string,
): NodeIdentity => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('dev' in value) ||
    !('ino' in value) ||
    typeof value.dev !== 'string' ||
    typeof value.ino !== 'string' ||
    !DECIMAL.test(value.dev) ||
    !DECIMAL.test(value.ino)
  ) {
    throw new Error(`Transaction reservation ${label} identity is invalid`);
  }
  const parsed = { dev: Number(value.dev), ino: Number(value.ino) };
  if (!(Number.isSafeInteger(parsed.dev) && Number.isSafeInteger(parsed.ino))) {
    throw new Error(`Transaction reservation ${label} identity is invalid`);
  }
  return parsed;
};

export const parseReservation = (contents: string): TransactionReservation => {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error('Transaction reservation is invalid', { cause: error });
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== RESERVATION_VERSION ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !UUID.test(value.id) ||
    !('root' in value) ||
    !('phase' in value) ||
    !['cleanup', 'parent-cleanup', 'publication'].includes(String(value.phase))
  ) {
    throw new Error('Transaction reservation is invalid');
  }
  reservationIdentity(value.root, 'root');
  if (value.phase === 'cleanup') {
    const hasDecision =
      'decision' in value &&
      ['committed', 'rolled-back'].includes(String(value.decision));
    if (
      !(
        hasDecision &&
        'reservedName' in value &&
        [TRANSACTION_CLEANUP, TRANSACTION_DIRECTORY].includes(
          String(value.reservedName),
        ) &&
        'transaction' in value
      )
    ) {
      throw new Error('Transaction cleanup reservation is invalid');
    }
    reservationIdentity(value.transaction, 'transaction');
  } else if (value.phase === 'parent-cleanup') {
    if (
      !(
        'decision' in value &&
        ['committed', 'rolled-back'].includes(String(value.decision)) &&
        'parent' in value &&
        'rel' in value &&
        typeof value.rel === 'string' &&
        value.rel.length > 0
      )
    ) {
      throw new Error('Created-parent cleanup reservation is invalid');
    }
    reservationIdentity(value.parent, 'parent');
  }
  return value as TransactionReservation;
};

export const reservationMatches = (
  reservation: TransactionReservation,
  root: NodeIdentity,
  id?: string,
): boolean =>
  identitiesMatch(root, reservationIdentity(reservation.root, 'root')) &&
  (id === undefined || reservation.id === id);
