import { mkdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  openPinnedChild,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch } from './sync-filesystem';
import { renameDirectoryNoReplace } from './sync-linux-rename';
import { removeOwnedTransaction } from './sync-transaction-artifact-cleanup';
import { transactionPublicationName } from './sync-transaction-artifact-names';
import {
  assertOwnerPublicationNamespaceAvailable,
  createOwnerPublicationToken,
  findOwnerPublicationToken,
} from './sync-transaction-owner-reservation';
import { removeOwnerPublicationToken } from './sync-transaction-owner-token-cleanup';
import { writeTransactionOwner } from './sync-transaction-ownership';
import { assertParentBindingNamespaceAvailable } from './sync-transaction-parent-binding';
import { assertTransactionPublicationNamespaceAvailable } from './sync-transaction-publication-namespace';
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
  reservedName,
  root,
  transaction,
}: {
  readonly created: boolean;
  readonly id: string;
  readonly reservedName: string;
  readonly root: PinnedDirectory;
  readonly transaction: PinnedDirectory | undefined;
}): Promise<ReadonlyArray<unknown>> => {
  if (created && transaction === undefined) {
    return [new Error('Unbound staged transaction publication was retained')];
  }
  if (transaction !== undefined) {
    try {
      const token = await findOwnerPublicationToken(root, transaction);
      if (token !== null && token.id !== id) {
        throw new Error('Owner publication token has a different reservation');
      }
      await removeOwnedTransaction({
        allowed: token === null ? new Set() : new Set([TRANSACTION_OWNER]),
        reservedName,
        root,
        transaction,
      });
      if (token !== null) {
        await removeOwnerPublicationToken(root, token);
      }
    } catch (error) {
      return [error];
    } finally {
      await transaction.handle.close().catch(() => undefined);
    }
  }
  try {
    await removeTransactionReservation(root, id);
  } catch (error) {
    return [error];
  }
  return [];
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
    readonly afterPublicationMkdir?: () => Promise<void>;
    readonly afterOwnerFinalSync?: () => Promise<void>;
    readonly afterOwnerPartialWrite?: () => Promise<void>;
    readonly afterOwnerReservationFinalSync?: () => Promise<void>;
    readonly afterReservationFinalSync?: () => Promise<void>;
    readonly afterReservationPartialWrite?: () => Promise<void>;
    readonly beforeMkdir?: () => Promise<void>;
  } = {},
): Promise<PinnedDirectory> => {
  await assertTransactionAbsent(root);
  await assertTransactionPublicationNamespaceAvailable(root);
  await assertOwnerPublicationNamespaceAvailable(root);
  await assertParentBindingNamespaceAvailable(root);
  await createTransactionReservation(root, id, {
    afterFinalSync: hooks.afterReservationFinalSync,
    afterPartialWrite: hooks.afterReservationPartialWrite,
  });
  let created = false;
  let reservedName = transactionPublicationName(id);
  let transaction: PinnedDirectory | undefined;
  try {
    await hooks.beforeMkdir?.();
    await mkdir(directoryEntryPath(root, reservedName), {
      mode: 0o700,
    });
    created = true;
    transaction = await openPinnedChild(root, reservedName);
    await syncPinnedDirectory(root);
    await hooks.afterPublicationMkdir?.();
    await createOwnerPublicationToken(
      root,
      transaction,
      id,
      hooks.afterOwnerReservationFinalSync,
    );
    renameDirectoryNoReplace(
      root.handle.fd,
      reservedName,
      TRANSACTION_DIRECTORY,
    );
    reservedName = TRANSACTION_DIRECTORY;
    await syncPinnedDirectory(root);
    await assertTransactionCurrent(root, transaction);
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
      reservedName,
      root,
      transaction,
    });
    if (cleanupErrors.length > 0) {
      throw publicationFailure(error, cleanupErrors);
    }
    throw error;
  }
};
