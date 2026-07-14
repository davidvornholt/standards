import { constants } from 'node:fs';
import { open, readdir, rmdir, unlink } from 'node:fs/promises';
import {
  directoryEntryPath,
  openPinnedChild,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import {
  TRANSACTION_COMMITTED,
  TRANSACTION_JOURNAL,
  TRANSACTION_JOURNAL_TEMP,
  TRANSACTION_OWNER,
  type TransactionJournal,
} from './sync-transaction-types';

type ArtifactSnapshot = ReadonlyMap<string, NodeIdentity>;

const artifactNames = (
  journal: TransactionJournal,
  committed: boolean,
): ReadonlySet<string> =>
  new Set([
    TRANSACTION_OWNER,
    TRANSACTION_JOURNAL,
    ...(committed ? [TRANSACTION_COMMITTED] : []),
    ...journal.operations.flatMap(({ backup, stage }) =>
      stage === null ? [backup] : [backup, stage],
    ),
  ]);

const identityOf = (info: { readonly dev: number; readonly ino: number }) => ({
  dev: info.dev,
  ino: info.ino,
});

const inspectArtifact = async (
  transaction: PinnedDirectory,
  name: string,
): Promise<NodeIdentity> => {
  const handle = await open(
    directoryEntryPath(transaction, name),
    constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`Transaction artifact must be a regular file: ${name}`);
    }
    return identityOf(info);
  } finally {
    await handle.close();
  }
};

const inspectArtifacts = async (
  transaction: PinnedDirectory,
  allowed: ReadonlySet<string>,
): Promise<ArtifactSnapshot> => {
  const entries = await readdir(directoryEntryPath(transaction, '.'));
  const unexpected = entries.filter((entry) => !allowed.has(entry));
  if (unexpected.length > 0) {
    throw new Error(
      `Transaction directory contains unexpected entries: ${unexpected.join(', ')}`,
    );
  }
  return new Map(
    await Promise.all(
      entries.map(
        async (entry) =>
          [entry, await inspectArtifact(transaction, entry)] as const,
      ),
    ),
  );
};

const assertSnapshot = (
  before: ArtifactSnapshot,
  after: ArtifactSnapshot,
): void => {
  if (
    before.size !== after.size ||
    [...before].some(
      ([name, identity]) => !identitiesMatch(identity, after.get(name) ?? null),
    )
  ) {
    throw new Error('Transaction artifacts changed during cleanup');
  }
};

const assertReservedIdentity = async (
  root: PinnedDirectory,
  reservedName: string,
  transaction: PinnedDirectory,
): Promise<void> => {
  const current = await openPinnedChild(root, reservedName);
  try {
    if (!identitiesMatch(current.identity, transaction.identity)) {
      throw new Error(`Reserved transaction entry changed: ${reservedName}`);
    }
  } finally {
    await current.handle.close();
  }
};

const deletionOrder = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...names].sort((left, right) => {
    const rank = (name: string): 0 | 1 | 2 => {
      if (name === TRANSACTION_OWNER) {
        return 2;
      }
      return name === TRANSACTION_JOURNAL ? 1 : 0;
    };
    return rank(left) - rank(right) || left.localeCompare(right);
  });

export const removeOwnedTransaction = async ({
  afterUnlink,
  allowed,
  beforeUnlink,
  beforeRmdir,
  reservedName,
  root,
  transaction,
  validate,
}: {
  readonly afterUnlink?: (name: string) => Promise<void>;
  readonly allowed: ReadonlySet<string>;
  readonly beforeUnlink?: () => Promise<void>;
  readonly beforeRmdir?: () => Promise<void>;
  readonly reservedName: string;
  readonly root: PinnedDirectory;
  readonly transaction: PinnedDirectory;
  readonly validate?: () => Promise<void>;
}): Promise<void> => {
  await validate?.();
  await assertReservedIdentity(root, reservedName, transaction);
  const snapshot = await inspectArtifacts(transaction, allowed);
  await beforeUnlink?.();
  await validate?.();
  await assertReservedIdentity(root, reservedName, transaction);
  assertSnapshot(snapshot, await inspectArtifacts(transaction, allowed));
  for (const name of deletionOrder([...snapshot.keys()])) {
    // biome-ignore lint/performance/noAwaitInLoops: every removal revalidates the remaining journal artifacts
    await validate?.();
    // Every unlink is preceded by an identity check through the pinned directory.
    const current = await inspectArtifact(transaction, name);
    if (!identitiesMatch(snapshot.get(name) ?? null, current)) {
      throw new Error(`Transaction artifact changed during cleanup: ${name}`);
    }
    await unlink(directoryEntryPath(transaction, name));
    await afterUnlink?.(name);
  }
  await syncPinnedDirectory(transaction);
  const remaining = await readdir(directoryEntryPath(transaction, '.'));
  if (remaining.length > 0) {
    throw new Error('Transaction directory changed during cleanup');
  }
  await beforeRmdir?.();
  await assertReservedIdentity(root, reservedName, transaction);
  await rmdir(directoryEntryPath(root, reservedName));
  await syncPinnedDirectory(root);
};

export const journalArtifactNames = artifactNames;

export const unpublishedArtifactNames = new Set([
  TRANSACTION_OWNER,
  TRANSACTION_JOURNAL,
  TRANSACTION_JOURNAL_TEMP,
]);

export const isUnpublishedTransaction = async (
  transaction: PinnedDirectory,
): Promise<boolean> => {
  const entries = await readdir(directoryEntryPath(transaction, '.'));
  return (
    !entries.includes(TRANSACTION_JOURNAL) &&
    entries.every((entry) =>
      [TRANSACTION_OWNER, TRANSACTION_JOURNAL_TEMP].includes(entry),
    )
  );
};
