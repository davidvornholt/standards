import { mkdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  openPinnedChild,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch } from './sync-filesystem';
import { removeOwnedTransaction } from './sync-transaction-artifact-cleanup';
import {
  assertOwnerPublicationNamespaceAvailable,
  createOwnerPublicationToken,
  findOwnerPublicationToken,
  removeOwnerPublicationToken,
} from './sync-transaction-owner-reservation';
import {
  assertTransactionOwner,
  readTransactionOwner,
  writeTransactionOwner,
} from './sync-transaction-ownership';
import { assertParentBindingNamespaceAvailable } from './sync-transaction-parent-binding';
import {
  createTransactionReservation,
  removeTransactionReservation,
} from './sync-transaction-reservation';
import {
  TRANSACTION_DIRECTORY,
  TRANSACTION_OWNER,
} from './sync-transaction-types';

const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

const assertTransactionAbsent = async (
  root: PinnedDirectory,
): Promise<void> => {
  try {
    const existing = await openPinnedChild(root, TRANSACTION_DIRECTORY);
    await existing.handle.close();
  } catch (error) {
    if (missing(error)) {
      return;
    }
    throw error;
  }
  throw new Error(
    `Reserved transaction entry already exists: ${TRANSACTION_DIRECTORY}`,
  );
};

const assertTransactionCurrent = async (
  root: PinnedDirectory,
  transaction: PinnedDirectory,
): Promise<void> => {
  const current = await openPinnedChild(root, TRANSACTION_DIRECTORY);
  try {
    if (!identitiesMatch(current.identity, transaction.identity)) {
      throw new Error('Reserved transaction entry changed during publication');
    }
  } finally {
    await current.handle.close();
  }
};

const cleanupFailedPublication = async ({
  created,
  id,
  root,
  transaction,
}: {
  readonly created: boolean;
  readonly id: string;
  readonly root: PinnedDirectory;
  readonly transaction: PinnedDirectory | undefined;
}): Promise<ReadonlyArray<unknown>> => {
  const errors: Array<unknown> = [];
  let opened = transaction;
  if (created) {
    try {
      opened ??= await openPinnedChild(root, TRANSACTION_DIRECTORY);
      const owner = await readTransactionOwner(opened);
      assertTransactionOwner(owner, root.identity, opened);
      if (owner.id !== id) {
        throw new Error('Transaction owner does not match its reservation');
      }
      await removeOwnedTransaction({
        allowed: new Set([TRANSACTION_OWNER]),
        reservedName: TRANSACTION_DIRECTORY,
        root,
        transaction: opened,
      });
    } catch (error) {
      errors.push(error);
    }
  }
  await opened?.handle.close().catch(() => undefined);
  if (errors.length === 0) {
    try {
      await removeTransactionReservation(root, id);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
};

const publicationFailure = (
  error: unknown,
  cleanupErrors: ReadonlyArray<unknown>,
): AggregateError =>
  new AggregateError(
    [error, ...cleanupErrors],
    'Could not clean failed transaction publication',
    { cause: error },
  );

export const createTransactionDirectory = async (
  root: PinnedDirectory,
  id: string,
  hooks: {
    readonly afterMkdir?: () => Promise<void>;
    readonly afterOwnerFinalSync?: () => Promise<void>;
    readonly afterOwnerPartialWrite?: () => Promise<void>;
    readonly afterOwnerReservationFinalSync?: () => Promise<void>;
    readonly afterReservationFinalSync?: () => Promise<void>;
    readonly afterReservationPartialWrite?: () => Promise<void>;
    readonly beforeMkdir?: () => Promise<void>;
  } = {},
): Promise<PinnedDirectory> => {
  await assertTransactionAbsent(root);
  await assertOwnerPublicationNamespaceAvailable(root);
  await assertParentBindingNamespaceAvailable(root);
  await createTransactionReservation(root, id, {
    afterFinalSync: hooks.afterReservationFinalSync,
    afterPartialWrite: hooks.afterReservationPartialWrite,
  });
  let created = false;
  let transaction: PinnedDirectory | undefined;
  try {
    await hooks.beforeMkdir?.();
    await mkdir(directoryEntryPath(root, TRANSACTION_DIRECTORY), {
      mode: 0o700,
    });
    created = true;
    transaction = await openPinnedChild(root, TRANSACTION_DIRECTORY);
    await assertTransactionCurrent(root, transaction);
    await createOwnerPublicationToken(
      root,
      transaction,
      id,
      hooks.afterOwnerReservationFinalSync,
    );
    await hooks.afterMkdir?.();
    await assertTransactionCurrent(root, transaction);
    await removeTransactionReservation(root, id);
    await writeTransactionOwner(transaction, root, id, {
      afterFinalSync: hooks.afterOwnerFinalSync,
      afterPartialWrite: hooks.afterOwnerPartialWrite,
    });
    await syncPinnedDirectory(root);
    const ownerToken = await findOwnerPublicationToken(root, transaction);
    if (ownerToken === null || ownerToken.id !== id) {
      throw new Error('Owner publication token disappeared');
    }
    await removeOwnerPublicationToken(root, ownerToken);
    return transaction;
  } catch (error) {
    const cleanupErrors = await cleanupFailedPublication({
      created,
      id,
      root,
      transaction,
    });
    if (cleanupErrors.length > 0) {
      throw publicationFailure(error, cleanupErrors);
    }
    throw error;
  }
};
