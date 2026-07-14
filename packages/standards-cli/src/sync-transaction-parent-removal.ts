import { rmdir, unlink } from 'node:fs/promises';
import {
  directoryEntryPath,
  openPinnedChild,
  type PinnedDirectory,
  type PinnedTarget,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch } from './sync-filesystem';
import {
  type CreatedParentBinding,
  removeParentBinding,
} from './sync-transaction-parent-binding';
import {
  assertOnlyCreatedParentMarker,
  createdParentMarkerName,
  verifyCreatedParentMarker,
} from './sync-transaction-parent-state';
import { removeTransactionReservation } from './sync-transaction-reservation';
import type {
  MutationFault,
  TransactionJournal,
} from './sync-transaction-types';

const assertCurrentDirectory = async (
  target: PinnedTarget,
  directory: PinnedDirectory,
): Promise<void> => {
  const current = await openPinnedChild(target.parent, target.name);
  try {
    if (!identitiesMatch(current.identity, directory.identity)) {
      throw new Error('Created parent changed during cleanup');
    }
  } finally {
    await current.handle.close();
  }
};

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
  if (await verifyCreatedParentMarker(directory, journal)) {
    await unlink(directoryEntryPath(directory, marker));
    await fault('parent-cleanup-marker-unlink', rel, 'after');
  }
  await syncPinnedDirectory(directory);
  await fault('parent-cleanup-directory-fsync', rel, 'after');
  if (!committed) {
    await assertOnlyCreatedParentMarker(directory, marker);
    await assertCurrentDirectory(target, directory);
    await rmdir(directoryEntryPath(target.parent, target.name));
    await fault('parent-cleanup-rmdir', rel, 'after');
    await syncPinnedDirectory(target.parent);
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
