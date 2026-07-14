import { link, unlink } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
  type PinnedTarget,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { assertPinnedFileExpected } from './sync-transaction-files';
import type { JournalOperation, MutationFault } from './sync-transaction-types';

export const backupTargetForRemoval = async ({
  fault,
  operation,
  target,
  transaction,
}: {
  readonly fault: MutationFault;
  readonly operation: JournalOperation;
  readonly target: PinnedTarget;
  readonly transaction: PinnedDirectory;
}): Promise<void> => {
  const backup = {
    name: operation.backup,
    parent: transaction,
    rel: operation.rel,
  };
  await fault('backup-link', operation.rel, 'before');
  await link(
    directoryEntryPath(target.parent, target.name),
    directoryEntryPath(transaction, operation.backup),
  );
  await fault('backup-link', operation.rel, 'after');
  await assertPinnedFileExpected(backup, operation.before);
  await fault('backup-transaction-fsync', operation.rel, 'before');
  await syncPinnedDirectory(transaction);
  await fault('backup-transaction-fsync', operation.rel, 'after');
  await fault('backup-unlink', operation.rel, 'before');
  await assertPinnedFileExpected(target, operation.before);
  await unlink(directoryEntryPath(target.parent, target.name));
  await fault('backup-unlink', operation.rel, 'after');
  await fault('backup-parent-fsync', operation.rel, 'before');
  await syncPinnedDirectory(target.parent);
  await fault('backup-parent-fsync', operation.rel, 'after');
};
