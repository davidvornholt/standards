import { constants } from 'node:fs';
import { open, readdir, unlink } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import { TRANSACTION_OWNER_PUBLICATION_PREFIX } from './sync-transaction-types';

const PRIVATE_MODE = 0o600;
const TOKEN =
  /^\.standards-owner-publication-(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-(?<dev>\d+)-(?<ino>\d+)$/u;

export type OwnerPublicationToken = {
  readonly id: string;
  readonly identity: NodeIdentity;
  readonly name: string;
  readonly transaction: NodeIdentity;
};

const tokenName = (transaction: PinnedDirectory, id: string): string =>
  `${TRANSACTION_OWNER_PUBLICATION_PREFIX}${id}-${transaction.identity.dev}-${transaction.identity.ino}`;

export const assertOwnerPublicationNamespaceAvailable = async (
  root: PinnedDirectory,
): Promise<void> => {
  const entries = (await readdir(directoryEntryPath(root, '.'))).filter(
    (entry) => entry.startsWith(TRANSACTION_OWNER_PUBLICATION_PREFIX),
  );
  if (entries.length > 0) {
    throw new Error('Owner publication token namespace is occupied');
  }
};

const inspectToken = async (
  root: PinnedDirectory,
  name: string,
): Promise<NodeIdentity> => {
  const handle = await open(
    directoryEntryPath(root, name),
    constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!(info.isFile() && info.size === 0)) {
      throw new Error('Owner publication token must be an empty regular file');
    }
    return { dev: info.dev, ino: info.ino };
  } finally {
    await handle.close();
  }
};

export const createOwnerPublicationToken = async (
  root: PinnedDirectory,
  transaction: PinnedDirectory,
  id: string,
  afterSync?: () => Promise<void>,
): Promise<void> => {
  const name = tokenName(transaction, id);
  await assertOwnerPublicationNamespaceAvailable(root);
  const handle = await open(
    directoryEntryPath(root, name),
    constants.O_CREAT +
      constants.O_EXCL +
      constants.O_WRONLY +
      constants.O_NOFOLLOW,
    PRIVATE_MODE,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const published = (await readdir(directoryEntryPath(root, '.'))).filter(
    (entry) => entry.startsWith(TRANSACTION_OWNER_PUBLICATION_PREFIX),
  );
  if (published.length !== 1 || published[0] !== name) {
    throw new Error('Owner publication token namespace changed');
  }
  await syncPinnedDirectory(root);
  await afterSync?.();
};

const findToken = async (
  root: PinnedDirectory,
): Promise<OwnerPublicationToken | null> => {
  const candidates = (await readdir(directoryEntryPath(root, '.'))).filter(
    (entry) => entry.startsWith(TRANSACTION_OWNER_PUBLICATION_PREFIX),
  );
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length !== 1) {
    throw new Error('Repository has multiple owner publication tokens');
  }
  const name = candidates[0] as string;
  const match = TOKEN.exec(name);
  const groups = match?.groups;
  if (groups === undefined) {
    throw new Error('Owner publication token is invalid');
  }
  const transaction = { dev: Number(groups.dev), ino: Number(groups.ino) };
  if (
    !(
      Number.isSafeInteger(transaction.dev) &&
      Number.isSafeInteger(transaction.ino)
    )
  ) {
    throw new Error('Owner publication token inode is invalid');
  }
  return {
    id: groups.id as string,
    identity: await inspectToken(root, name),
    name,
    transaction,
  };
};

export const findOwnerPublicationToken = async (
  root: PinnedDirectory,
  transaction: PinnedDirectory,
): Promise<OwnerPublicationToken | null> => {
  const token = await findToken(root);
  if (
    token !== null &&
    !identitiesMatch(token.transaction, transaction.identity)
  ) {
    throw new Error('Owner publication token does not match active inode');
  }
  return token;
};

export const removeOrphanOwnerPublicationToken = async (
  root: PinnedDirectory,
  reservationId?: string,
  mutate = true,
): Promise<void> => {
  const token = await findToken(root);
  if (token === null) {
    return;
  }
  if (reservationId !== undefined && token.id !== reservationId) {
    throw new Error('Owner publication token has a different reservation');
  }
  if (!mutate) {
    throw new Error('Pending owner publication token cleanup');
  }
  await removeOwnerPublicationToken(root, token);
};

export const removeOwnerPublicationToken = async (
  root: PinnedDirectory,
  token: OwnerPublicationToken,
): Promise<void> => {
  const current = await inspectToken(root, token.name);
  if (!identitiesMatch(token.identity, current)) {
    throw new Error('Owner publication token changed during cleanup');
  }
  await unlink(directoryEntryPath(root, token.name));
  await syncPinnedDirectory(root);
};
