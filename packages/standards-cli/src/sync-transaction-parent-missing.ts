import {
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import {
  type CreatedParentBinding,
  removeParentBinding,
} from './sync-transaction-parent-binding';
import { removeTransactionReservation } from './sync-transaction-reservation';
import type { ParentCleanupReservation } from './sync-transaction-reservation-record';
import type { TransactionJournal } from './sync-transaction-types';

export const finishMissingCreatedParent = async ({
  binding,
  committed,
  durableParent,
  index,
  journal,
  reservation,
  root,
}: {
  readonly binding: CreatedParentBinding | null;
  readonly committed: boolean;
  readonly durableParent: PinnedDirectory;
  readonly index: number;
  readonly journal: TransactionJournal;
  readonly reservation: ParentCleanupReservation | null;
  readonly root: PinnedDirectory;
}): Promise<void> => {
  if (reservation?.decision === 'committed' || committed) {
    throw new Error('Committed created parent disappeared during cleanup');
  }
  if (binding !== null || reservation !== null) {
    await syncPinnedDirectory(durableParent);
  }
  if (binding !== null) {
    await removeParentBinding({ binding, index, journal, root });
  }
  if (reservation !== null) {
    await removeTransactionReservation(root, journal.id);
  }
};
