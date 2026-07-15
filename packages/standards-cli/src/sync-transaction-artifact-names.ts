import {
  REMOVAL_BINDING_PREFIX,
  RESERVED_TRANSACTION_ARTIFACT_GRAMMAR as TRANSACTION_ARTIFACT_GRAMMAR,
  TRANSACTION_CLEANUP,
  TRANSACTION_DIRECTORY,
  TRANSACTION_OWNER,
  TRANSACTION_OWNER_PUBLICATION_PREFIX,
  TRANSACTION_OWNER_RESERVATION,
  TRANSACTION_PARENT_BINDING_PREFIX,
  TRANSACTION_PARENT_PREFIX,
  TRANSACTION_PUBLICATION_PREFIX,
  TRANSACTION_RESERVATION,
} from './sync-transaction-namespace';

export const RESERVED_TRANSACTION_ARTIFACT_GRAMMAR =
  TRANSACTION_ARTIFACT_GRAMMAR;

const UUID_V4_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_V4 = new RegExp(`^${UUID_V4_SOURCE}$`, 'u');
const regexEscape = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const PARENT_BINDING_TAIL = new RegExp(
  `^${regexEscape(TRANSACTION_PARENT_BINDING_PREFIX)}${UUID_V4_SOURCE}-(?:0|[1-9]\\d*)\\.${UUID_V4_SOURCE}\\.tmp$`,
  'u',
);

export const isUuidV4 = (value: string): boolean => UUID_V4.test(value);

export const transactionPublicationName = (id: string): string => {
  if (!isUuidV4(id)) {
    throw new Error('Transaction publication ID must be UUID-v4');
  }
  return `${TRANSACTION_PUBLICATION_PREFIX}${id}`;
};

export const transactionPublicationId = (name: string): string | null => {
  if (!name.startsWith(TRANSACTION_PUBLICATION_PREFIX)) {
    return null;
  }
  const id = name.slice(TRANSACTION_PUBLICATION_PREFIX.length);
  return isUuidV4(id) ? id : null;
};

export const atomicRecordTemporaryName = (
  finalName: string,
  id: string,
): string => {
  if (!isUuidV4(id)) {
    throw new Error('Atomic transaction record temporary ID must be UUID-v4');
  }
  return `${finalName}.${id}.tmp`;
};

export const isAtomicRecordTemporaryName = (
  name: string,
  finalName: string,
): boolean => {
  const prefix = `${finalName}.`;
  if (!(name.startsWith(prefix) && name.endsWith('.tmp'))) {
    return false;
  }
  return isUuidV4(name.slice(prefix.length, -'.tmp'.length));
};

export const isReservedAtomicRecordTemporaryName = (name: string): boolean =>
  isAtomicRecordTemporaryName(name, TRANSACTION_RESERVATION) ||
  isAtomicRecordTemporaryName(name, TRANSACTION_OWNER) ||
  (name.startsWith(TRANSACTION_PARENT_BINDING_PREFIX) &&
    PARENT_BINDING_TAIL.test(name));

const RESERVED_TRANSACTION_NAMES = new Set([
  TRANSACTION_CLEANUP,
  TRANSACTION_DIRECTORY,
  TRANSACTION_OWNER_RESERVATION,
  TRANSACTION_RESERVATION,
]);

export const isReservedTransactionPath = (rel: string): boolean =>
  rel
    .split('/')
    .some(
      (part) =>
        RESERVED_TRANSACTION_NAMES.has(part) ||
        isReservedAtomicRecordTemporaryName(part) ||
        part.startsWith(TRANSACTION_OWNER_PUBLICATION_PREFIX) ||
        part.startsWith(TRANSACTION_PARENT_BINDING_PREFIX) ||
        part.startsWith(TRANSACTION_PUBLICATION_PREFIX) ||
        part.startsWith(REMOVAL_BINDING_PREFIX) ||
        part.startsWith(TRANSACTION_PARENT_PREFIX),
    );
