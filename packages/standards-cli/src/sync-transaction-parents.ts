import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  type CreatedDirectory,
  directoryEntryPath,
  openPinnedChild,
  syncPinnedDirectory,
} from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import { finishCreatedParent } from './sync-transaction-parent-cleanup';
import { createdParentMarkerName } from './sync-transaction-parent-state';
import type {
  MutationFault,
  TransactionJournal,
} from './sync-transaction-types';

const PRIVATE_MODE = 0o600;
export const markCreatedParents = async (
  created: ReadonlyArray<CreatedDirectory>,
  journal: TransactionJournal,
  fault: MutationFault,
): Promise<void> => {
  await Promise.all(
    created.map(async ({ name, parent, rel }) => {
      const directory = await openPinnedChild(parent, name);
      try {
        const marker = await open(
          directoryEntryPath(directory, createdParentMarkerName(journal.id)),
          constants.O_CREAT +
            constants.O_EXCL +
            constants.O_WRONLY +
            constants.O_NOFOLLOW,
          PRIVATE_MODE,
        );
        try {
          await marker.writeFile(journal.id);
          await marker.sync();
          await fault('parent-marker', rel, 'after');
        } finally {
          await marker.close();
        }
        await syncPinnedDirectory(directory);
        await fault('parent-marker-fsync', rel, 'after');
      } finally {
        await directory.handle.close();
      }
    }),
  );
};

export const finishCreatedParents = async ({
  committed,
  fault,
  journal,
  root,
  rootDirectory,
}: {
  readonly committed: boolean;
  readonly fault: MutationFault;
  readonly journal: TransactionJournal;
  readonly root: RepositoryRoot;
  readonly rootDirectory: import('./sync-directory-handles').PinnedDirectory;
}): Promise<Array<unknown>> => {
  const errors: Array<unknown> = [];
  const indexes = journal.createdParents
    .map((_, index) => index)
    .sort(
      (left, right) =>
        (journal.createdParents[right]?.length ?? 0) -
        (journal.createdParents[left]?.length ?? 0),
    );
  for (const index of indexes) {
    try {
      // Nested created directories must finish deepest-first.
      // biome-ignore lint/performance/noAwaitInLoops: parent ordering is transactional
      await finishCreatedParent({
        committed,
        fault,
        index,
        journal,
        root,
        rootDirectory,
      });
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
};
