import { readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  openPinnedChild,
  type PinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch } from './sync-filesystem';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';
import { findRemovalBinding } from './sync-transaction-quarantine-read';
import {
  TRANSACTION_JOURNAL,
  TRANSACTION_OWNER,
} from './sync-transaction-types';

const assertReservedIdentity = async (
  root: PinnedDirectory,
  reservedName: string,
  transaction: PinnedDirectory,
): Promise<void> => {
  let identity =
    (await findRemovalBinding(root, reservedName, transaction.identity))
      ?.identity ?? null;
  if (identity === null) {
    try {
      const current = await openPinnedChild(root, reservedName);
      ({ identity } = current);
      await current.handle.close();
    } catch (error) {
      if ((error as { readonly code?: unknown }).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  if (!identitiesMatch(identity, transaction.identity)) {
    throw new Error(`Reserved transaction entry changed: ${reservedName}`);
  }
};

const checkpointOrder = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...names].sort((left, right) => {
    const rank = (name: string): 0 | 1 | 2 => {
      if (name === TRANSACTION_OWNER) {
        return 2;
      }
      return name === TRANSACTION_JOURNAL ? 1 : 0;
    };
    return rank(left) - rank(right) || left.localeCompare(right);
  });

export const assertTransactionDirectoryEmpty = async (
  transaction: PinnedDirectory,
): Promise<void> => {
  const entries = await readdir(directoryEntryPath(transaction, '.'));
  if (entries.length > 0) {
    throw new Error(
      `Transaction directory contains unexpected entries: ${entries.join(', ')}`,
    );
  }
};

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
  for (const name of checkpointOrder([...allowed])) {
    // biome-ignore lint/performance/noAwaitInLoops: crash checkpoints preserve the historical cleanup order
    await beforeUnlink?.();
    await afterUnlink?.(name);
  }
  await validate?.();
  await beforeRmdir?.();
  await bindAndRemoveEntry({
    afterBind: afterRmdirBind,
    directory: root,
    expected: transaction.identity,
    kind: 'directory',
    name: reservedName,
  });
};
