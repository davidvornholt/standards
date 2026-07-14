import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import { renameDirectoryNoReplace } from './sync-linux-rename';
import { assertFilesystemIdentityComponent } from './sync-node-identity';
import { resolveRemovalEntryName } from './sync-transaction-quarantine-read';
import { TRANSACTION_OWNER_PUBLICATION_PREFIX } from './sync-transaction-types';

const PRIVATE_MODE = 0o600;
const TOKEN =
  /^\.standards-owner-publication-(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-(?<dev>\d+)-(?<ino>\d+)(?:-(?<ownerDev>\d+)-(?<ownerIno>\d+))?$/u;

const tokenIdentity = (dev: string, ino: string): NodeIdentity => ({
  dev: assertFilesystemIdentityComponent(
    BigInt(dev),
    'Owner publication token dev',
  ),
  ino: assertFilesystemIdentityComponent(
    BigInt(ino),
    'Owner publication token ino',
  ),
});

export type OwnerPublicationToken = {
  readonly id: string;
  readonly identity: NodeIdentity;
  readonly name: string;
  readonly ownerRecord: NodeIdentity | null;
  readonly transaction: NodeIdentity;
};

const tokenName = (
  transaction: PinnedDirectory,
  id: string,
  ownerRecord?: NodeIdentity,
): string =>
  `${TRANSACTION_OWNER_PUBLICATION_PREFIX}${id}-${transaction.identity.dev}-${transaction.identity.ino}${
    ownerRecord === undefined ? '' : `-${ownerRecord.dev}-${ownerRecord.ino}`
  }`;

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
    directoryEntryPath(root, await resolveRemovalEntryName(root, name)),
    constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat({ bigint: true });
    if (!(info.isFile() && info.size === 0n)) {
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

export const findOwnerPublicationTokenEntry = async (
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
  const ownerRecord =
    groups.ownerDev === undefined || groups.ownerIno === undefined
      ? null
      : tokenIdentity(groups.ownerDev, groups.ownerIno);
  const exactTransaction = tokenIdentity(
    groups.dev as string,
    groups.ino as string,
  );
  if (
    exactTransaction.dev.toString() !== groups.dev ||
    exactTransaction.ino.toString() !== groups.ino ||
    (ownerRecord !== null &&
      (ownerRecord.dev.toString() !== groups.ownerDev ||
        ownerRecord.ino.toString() !== groups.ownerIno))
  ) {
    throw new Error('Owner publication token inode is invalid');
  }
  return {
    id: groups.id as string,
    identity: await inspectToken(root, name),
    name,
    ownerRecord,
    transaction: exactTransaction,
  };
};

export const bindOwnerPublicationToken = async (
  root: PinnedDirectory,
  transaction: PinnedDirectory,
  id: string,
  ownerRecord: NodeIdentity,
): Promise<void> => {
  const token = await findOwnerPublicationToken(root, transaction);
  if (token === null || token.id !== id || token.ownerRecord !== null) {
    throw new Error('Owner publication token cannot bind the owner record');
  }
  const boundName = tokenName(transaction, id, ownerRecord);
  renameDirectoryNoReplace(root.handle.fd, token.name, boundName);
  await syncPinnedDirectory(root);
  const boundIdentity = await inspectToken(root, boundName);
  if (!identitiesMatch(token.identity, boundIdentity)) {
    throw new Error('Owner publication token changed during record binding');
  }
};

export const findOwnerPublicationToken = async (
  root: PinnedDirectory,
  transaction: PinnedDirectory,
): Promise<OwnerPublicationToken | null> => {
  const token = await findOwnerPublicationTokenEntry(root);
  if (
    token !== null &&
    !identitiesMatch(token.transaction, transaction.identity)
  ) {
    throw new Error('Owner publication token does not match active inode');
  }
  return token;
};
