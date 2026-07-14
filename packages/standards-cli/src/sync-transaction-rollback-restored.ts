import {
  type PinnedDirectory,
  type PinnedTarget,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { type FileState, identitiesMatch } from './sync-filesystem';
import {
  rollbackBindingName,
  unlinkPinnedIdentity,
} from './sync-transaction-bound-unlink';
import type { JournalOperation } from './sync-transaction-types';

export const cleanupRestoredBackup = async ({
  backupState,
  backupTarget,
  operation,
  target,
  targetState,
  transaction,
}: {
  readonly backupState: FileState;
  readonly backupTarget: PinnedTarget;
  readonly operation: JournalOperation;
  readonly target: PinnedTarget;
  readonly targetState: FileState;
  readonly transaction: PinnedDirectory;
}): Promise<void> => {
  if (
    targetState.identity === null ||
    !identitiesMatch(targetState.identity, backupState.identity)
  ) {
    throw new Error(
      `Recovery found two prior-file candidates: ${operation.rel}`,
    );
  }
  if (backupState.identity === null) {
    throw new Error(`Recovery backup has no identity: ${operation.rel}`);
  }
  await syncPinnedDirectory(target.parent);
  await unlinkPinnedIdentity({
    bindingName: rollbackBindingName(operation.backup),
    expected: backupState.identity,
    message: `Recovery backup changed before cleanup: ${operation.rel}`,
    target: backupTarget,
    transaction,
  });
  await syncPinnedDirectory(transaction);
};
