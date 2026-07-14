import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  openPinnedChild,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import {
  identitiesMatch,
  identityOf,
  type NodeIdentity,
} from './sync-filesystem';
import {
  bindAndRemoveEntry,
  findRemovalBinding,
  removalBindingIdentity,
} from './sync-transaction-bound-remove';
import {
  TRANSACTION_JOURNAL,
  TRANSACTION_OWNER,
} from './sync-transaction-types';

type ArtifactSnapshot = ReadonlyMap<string, NodeIdentity>;

const inspectArtifact = async (
  transaction: PinnedDirectory,
  name: string,
): Promise<NodeIdentity> => {
  const handle = await open(
    directoryEntryPath(transaction, name),
    constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat({ bigint: true });
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
  const snapshot = new Map<string, NodeIdentity>();
  const unexpected: Array<string> = [];
  const inspected = await Promise.all(
    entries.map(async (entry) => {
      const logicalName = allowed.has(entry)
        ? entry
        : [...allowed].find(
            (allowedName) =>
              removalBindingIdentity(allowedName, entry) !== null,
          );
      if (logicalName === undefined) {
        return { entry, logicalName: null };
      }
      const identity = await inspectArtifact(transaction, entry);
      const boundIdentity = removalBindingIdentity(logicalName, entry);
      if (boundIdentity !== null && !identitiesMatch(boundIdentity, identity)) {
        throw new Error(
          `Transaction artifact removal binding changed: ${entry}`,
        );
      }
      return { entry, identity, logicalName };
    }),
  );
  for (const item of inspected) {
    if (item.logicalName === null || snapshot.has(item.logicalName)) {
      unexpected.push(item.entry);
    } else {
      snapshot.set(item.logicalName, item.identity as NodeIdentity);
    }
  }
  if (unexpected.length > 0) {
    throw new Error(
      `Transaction directory contains unexpected entries: ${unexpected.join(', ')}`,
    );
  }
  return snapshot;
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
  let current: PinnedDirectory | null = null;
  try {
    current = await openPinnedChild(root, reservedName);
  } catch (error) {
    if ((error as { readonly code?: unknown }).code !== 'ENOENT') {
      throw error;
    }
  }
  try {
    const identity =
      current?.identity ??
      (await findRemovalBinding(root, reservedName))?.identity;
    if (!identitiesMatch(identity ?? null, transaction.identity)) {
      throw new Error(`Reserved transaction entry changed: ${reservedName}`);
    }
  } finally {
    await current?.handle.close();
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
  afterRmdirBind,
  allowed,
  beforeUnlink,
  beforeRmdir,
  reservedName,
  root,
  transaction,
  validate,
}: {
  readonly afterUnlink?: (name: string) => Promise<void>;
  readonly afterRmdirBind?: () => Promise<void>;
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
    await bindAndRemoveEntry({
      directory: transaction,
      expected: snapshot.get(name) as NodeIdentity,
      kind: 'file',
      name,
    });
    await afterUnlink?.(name);
  }
  await syncPinnedDirectory(transaction);
  const remaining = await readdir(directoryEntryPath(transaction, '.'));
  if (remaining.length > 0) {
    throw new Error('Transaction directory changed during cleanup');
  }
  await beforeRmdir?.();
  await assertReservedIdentity(root, reservedName, transaction);
  await bindAndRemoveEntry({
    afterBind: afterRmdirBind,
    directory: root,
    expected: transaction.identity,
    kind: 'directory',
    name: reservedName,
  });
};
