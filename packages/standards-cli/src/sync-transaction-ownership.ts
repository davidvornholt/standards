import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import { publishAtomicTransactionRecord } from './sync-transaction-atomic-record';
import { bindOwnerPublicationToken } from './sync-transaction-owner-reservation';
import { TRANSACTION_OWNER } from './sync-transaction-types';

const OWNER_VERSION = 1;
const MAX_OWNER_BYTES = 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL = /^\d+$/u;

export type TransactionOwner = {
  readonly id: string;
  readonly root: { readonly dev: string; readonly ino: string };
  readonly transaction: { readonly dev: string; readonly ino: string };
  readonly version: typeof OWNER_VERSION;
};

const storedIdentity = (identity: NodeIdentity) => ({
  dev: String(identity.dev),
  ino: String(identity.ino),
});

const parseIdentity = (value: unknown, label: string): NodeIdentity => {
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
    throw new Error(`Transaction owner ${label} identity is invalid`);
  }
  const identity = { dev: Number(value.dev), ino: Number(value.ino) };
  if (
    !(Number.isSafeInteger(identity.dev) && Number.isSafeInteger(identity.ino))
  ) {
    throw new Error(`Transaction owner ${label} identity is invalid`);
  }
  return identity;
};

const parseOwner = (contents: string): TransactionOwner => {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error('Transaction owner record is invalid', { cause: error });
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== OWNER_VERSION ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !UUID.test(value.id) ||
    !('root' in value) ||
    !('transaction' in value)
  ) {
    throw new Error('Transaction owner record is invalid');
  }
  parseIdentity(value.root, 'root');
  parseIdentity(value.transaction, 'directory');
  return value as TransactionOwner;
};

export const readTransactionOwner = async (
  transaction: PinnedDirectory,
): Promise<TransactionOwner> => {
  const handle = await open(
    directoryEntryPath(transaction, TRANSACTION_OWNER),
    constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!(info.isFile() && info.size <= MAX_OWNER_BYTES)) {
      throw new Error('Transaction owner record must be a small regular file');
    }
    return parseOwner(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
};

export const assertTransactionOwner = (
  owner: TransactionOwner,
  root: NodeIdentity,
  transaction: PinnedDirectory,
): void => {
  if (
    !(
      identitiesMatch(root, parseIdentity(owner.root, 'root')) &&
      identitiesMatch(
        transaction.identity,
        parseIdentity(owner.transaction, 'directory'),
      )
    )
  ) {
    throw new Error('Transaction owner record does not match its repository');
  }
};

export const writeTransactionOwner = async (
  transaction: PinnedDirectory,
  root: PinnedDirectory,
  id: string,
  hooks: {
    readonly afterFinalSync?: () => Promise<void>;
    readonly afterPartialWrite?: () => Promise<void>;
  } = {},
): Promise<void> => {
  const owner: TransactionOwner = {
    id,
    root: storedIdentity(root.identity),
    transaction: storedIdentity(transaction.identity),
    version: OWNER_VERSION,
  };
  await publishAtomicTransactionRecord({
    afterFinalSync: hooks.afterFinalSync,
    afterPartialWrite: hooks.afterPartialWrite,
    afterTemporaryOpen: (identity) =>
      bindOwnerPublicationToken(root, transaction, id, identity),
    contents: `${JSON.stringify(owner)}\n`,
    directory: transaction,
    finalName: TRANSACTION_OWNER,
    maximumBytes: MAX_OWNER_BYTES,
  });
};
