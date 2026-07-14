import type { PinnedDirectory } from './sync-directory-handles';
import { removeOwnedTransaction } from './sync-transaction-artifact-cleanup';
import {
  assertCleanupReservation,
  type CleanupReservation,
  createCleanupReservation,
  readTransactionReservation,
  removeTransactionReservation,
} from './sync-transaction-reservation';
import type {
  TRANSACTION_CLEANUP,
  TRANSACTION_DIRECTORY,
} from './sync-transaction-types';

export const removeOwnedTransactionDurably = async ({
  id,
  root,
  decision,
  afterReservationPartialWrite,
  ...cleanup
}: Omit<Parameters<typeof removeOwnedTransaction>[0], 'root'> & {
  readonly decision: CleanupReservation['decision'];
  readonly afterReservationPartialWrite?: () => Promise<void>;
  readonly id: string;
  readonly root: PinnedDirectory;
  readonly reservedName:
    | typeof TRANSACTION_CLEANUP
    | typeof TRANSACTION_DIRECTORY;
}): Promise<void> => {
  try {
    await createCleanupReservation({
      decision,
      hooks: { afterPartialWrite: afterReservationPartialWrite },
      id,
      root,
      ...cleanup,
    });
  } catch (error) {
    if ((error as { readonly code?: unknown }).code !== 'EEXIST') {
      throw error;
    }
    const reservation = await readTransactionReservation(root);
    const values = {
      id,
      reservation,
      reservedName: cleanup.reservedName,
      root: root.identity,
      transaction: cleanup.transaction,
    };
    assertCleanupReservation(values);
    if (values.reservation.decision !== decision) {
      throw new Error('Transaction cleanup decision changed', { cause: error });
    }
  }
  await removeOwnedTransaction({ ...cleanup, root });
  await removeTransactionReservation(root, id);
};
