import {
  closePinnedDirectories,
  type PinnedDirectory,
} from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import { identitiesMatch } from './sync-filesystem';
import {
  type CreatedParentBinding,
  readParentBinding,
} from './sync-transaction-parent-binding';
import { finishMissingCreatedParent } from './sync-transaction-parent-missing';
import { openCreatedParent } from './sync-transaction-parent-open';
import { removeCreatedParent } from './sync-transaction-parent-removal';
import {
  assertParentCleanupReservation,
  createParentCleanupReservation,
} from './sync-transaction-parent-reservation';
import {
  assertOnlyCreatedParentMarker,
  createdParentMarkerName,
  readParentCleanupReservation,
  verifyCreatedParentMarker,
} from './sync-transaction-parent-state';
import type { ParentCleanupReservation } from './sync-transaction-reservation-record';
import { reservationIdentity } from './sync-transaction-reservation-record';
import type {
  MutationFault,
  TransactionJournal,
} from './sync-transaction-types';

const ensureCleanupReservation = async ({
  committed,
  binding,
  directory,
  fault,
  journal,
  rel,
  reservation,
  root,
  rootDirectory,
}: {
  readonly binding: CreatedParentBinding | null;
  readonly committed: boolean;
  readonly directory: PinnedDirectory;
  readonly fault: MutationFault;
  readonly journal: TransactionJournal;
  readonly index: number;
  readonly rel: string;
  readonly reservation: ParentCleanupReservation | null;
  readonly root: RepositoryRoot;
  readonly rootDirectory: PinnedDirectory;
}): Promise<boolean> => {
  if (reservation !== null) {
    const values = {
      id: journal.id,
      parent: directory,
      rel,
      reservation,
      root: root.identity,
    };
    assertParentCleanupReservation(values);
    if (
      values.reservation.decision !== (committed ? 'committed' : 'rolled-back')
    ) {
      throw new Error('Created-parent cleanup decision changed');
    }
    return true;
  }
  const markerPresent = await verifyCreatedParentMarker(directory, journal);
  if (binding === null) {
    if (committed && !markerPresent) {
      return false;
    }
    throw new Error('Created parent has no durable inode binding');
  }
  if (!identitiesMatch(binding.parent, directory.identity)) {
    throw new Error('Created parent does not match its durable inode binding');
  }
  if (!committed) {
    await assertOnlyCreatedParentMarker(
      directory,
      createdParentMarkerName(journal.id),
    );
  }
  await createParentCleanupReservation({
    decision: committed ? 'committed' : 'rolled-back',
    hooks: {
      afterFinalSync: () => fault('parent-cleanup-token', rel, 'after'),
      afterPartialWrite: () =>
        fault('parent-cleanup-token-write', rel, 'after'),
    },
    id: journal.id,
    parent: directory,
    rel,
    root: rootDirectory,
  });
  return true;
};

export const finishCreatedParent = async ({
  committed,
  fault,
  index,
  journal,
  root,
  rootDirectory,
}: {
  readonly committed: boolean;
  readonly fault: MutationFault;
  readonly index: number;
  readonly journal: TransactionJournal;
  readonly root: RepositoryRoot;
  readonly rootDirectory: PinnedDirectory;
}): Promise<void> => {
  const rel = journal.createdParents[index] as string;
  const reservation = await readParentCleanupReservation(
    rootDirectory,
    journal,
    rel,
  );
  const binding = await readParentBinding(rootDirectory, journal, index);
  const opened: Array<PinnedDirectory> = [];
  try {
    const expectedParent =
      binding?.parent ??
      (reservation === null
        ? undefined
        : reservationIdentity(reservation.parent, 'created parent'));
    const parent = await openCreatedParent(root, rel, opened, expectedParent);
    if (parent.directory === null) {
      await finishMissingCreatedParent({
        binding,
        committed,
        durableParent: parent.target?.parent ?? rootDirectory,
        index,
        journal,
        reservation,
        root: rootDirectory,
      });
      return;
    }
    const shouldRemove = await ensureCleanupReservation({
      binding,
      committed,
      directory: parent.directory,
      fault,
      journal,
      index,
      rel,
      reservation,
      root,
      rootDirectory,
    });
    if (!shouldRemove) {
      return;
    }
    await removeCreatedParent({
      binding,
      committed,
      directory: parent.directory,
      fault,
      journal,
      index,
      rel,
      rootDirectory,
      target: parent.target,
    });
  } finally {
    await closePinnedDirectories(opened);
  }
};
