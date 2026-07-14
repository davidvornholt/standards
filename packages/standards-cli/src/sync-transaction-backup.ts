import { link } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
  type PinnedTarget,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';
import { assertPinnedFileExpected } from './sync-transaction-files';
import {
  expectedIdentity,
  type JournalOperation,
  type MutationFault,
  removedBackupName,
} from './sync-transaction-types';

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
  const identity = expectedIdentity(operation.before);
  if (identity === null) {
    throw new Error(`Backup identity is missing: ${operation.rel}`);
  }
  await bindAndRemoveEntry({
    directory: transaction,
    expected: identity,
    kind: 'file',
    name: removedBackupName(operation.backup),
    sourceDirectory: target.parent,
    sourceName: target.name,
  });
  await fault('backup-unlink', operation.rel, 'after');
  await fault('backup-parent-fsync', operation.rel, 'before');
  await syncPinnedDirectory(target.parent);
  await fault('backup-parent-fsync', operation.rel, 'after');
};
