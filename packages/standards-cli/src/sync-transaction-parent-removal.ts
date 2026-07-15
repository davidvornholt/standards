import {
  type PinnedDirectory,
  type PinnedTarget,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';
import { TRANSACTION_PARENT_PREFIX } from './sync-transaction-namespace';
import type { CreatedParentBinding } from './sync-transaction-parent-binding';
import { removeParentBinding } from './sync-transaction-parent-binding-cleanup';
import {
  assertOnlyCreatedParentMarker,
  createdParentMarkerIdentity,
  createdParentMarkerName,
} from './sync-transaction-parent-state';
import { removeTransactionReservation } from './sync-transaction-reservation';
import type {
  MutationFault,
  TransactionJournal,
} from './sync-transaction-types';

export const removeCreatedParent = async ({
  binding,
  committed,
  directory,
  fault,
  journal,
  index,
  rel,
  rootDirectory,
  target,
}: {
  readonly binding: CreatedParentBinding | null;
  readonly committed: boolean;
  readonly directory: PinnedDirectory;
  readonly fault: MutationFault;
  readonly journal: TransactionJournal;
  readonly index: number;
  readonly rel: string;
  readonly rootDirectory: PinnedDirectory;
  readonly target: PinnedTarget;
}): Promise<void> => {
  const marker = createdParentMarkerName(journal.id);
  const markerIdentity = await createdParentMarkerIdentity(directory, journal);
  if (committed && markerIdentity !== null) {
    await bindAndRemoveEntry({
      afterRemove: () => fault('parent-cleanup-marker-unlink', rel, 'after'),
      directory: rootDirectory,
      expected: markerIdentity,
      kind: 'file',
      name: `${TRANSACTION_PARENT_PREFIX}marker-${journal.id}-${index}`,
      sourceDirectory: directory,
      sourceName: marker,
    });
  }
  await syncPinnedDirectory(directory);
  await fault('parent-cleanup-directory-fsync', rel, 'after');
  if (!committed) {
    await assertOnlyCreatedParentMarker(directory, marker);
    await bindAndRemoveEntry({
      afterRemove: () => fault('parent-cleanup-rmdir', rel, 'after'),
      directory: target.parent,
      expected: directory.identity,
      kind: 'directory',
      name: target.name,
    });
    await fault('parent-cleanup-parent-fsync', rel, 'after');
  }
  if (binding !== null) {
    await removeParentBinding({
      binding,
      hooks: {
        afterSync: () => fault('parent-cleanup-binding-fsync', rel, 'after'),
        afterUnlink: () => fault('parent-cleanup-binding-unlink', rel, 'after'),
      },
      index,
      journal,
      root: rootDirectory,
    });
  }
  await removeTransactionReservation(rootDirectory, journal.id, {
    afterSync: () => fault('parent-cleanup-reservation-fsync', rel, 'after'),
    afterUnlink: () => fault('parent-cleanup-reservation-unlink', rel, 'after'),
  });
  await fault('parent-cleanup-token-unlink', rel, 'after');
};
