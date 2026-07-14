import {
  closePinnedDirectories,
  openPinnedRoot,
} from './sync-directory-handles';
import { inspectRepositoryFile, type RepositoryRoot } from './sync-filesystem';
import { fileMatchesDesired } from './sync-transaction-files';
import type { TransactionJournal } from './sync-transaction-types';

export const verifyDesiredRootTree = async (
  root: RepositoryRoot,
  journal: TransactionJournal,
): Promise<void> => {
  const currentRoot = await openPinnedRoot(root);
  await closePinnedDirectories([currentRoot]);
  await Promise.all(
    journal.operations.map(async (operation) => {
      const state = await inspectRepositoryFile(root, operation.rel);
      if (operation.desired === null) {
        if (state.contents !== null) {
          throw new Error(
            `Final root-linked deletion is incomplete: ${operation.rel}`,
          );
        }
        return;
      }
      if (!fileMatchesDesired(state, operation.desired)) {
        throw new Error(
          `Final root-linked write is incomplete: ${operation.rel}`,
        );
      }
    }),
  );
};
