import { link } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
  type PinnedTarget,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import {
  rollbackBindingName,
  unlinkPinnedIdentity,
} from './sync-transaction-bound-unlink';
import { fileMatchesExpected } from './sync-transaction-files';
import {
  inspectPresentRollbackState,
  resumePresentRollbackBinding,
} from './sync-transaction-rollback-binding';
import { rollbackMissing } from './sync-transaction-rollback-missing';
import { cleanupRestoredBackup } from './sync-transaction-rollback-restored';
import type { JournalOperation, MutationFault } from './sync-transaction-types';

const faulted = async (
  fault: MutationFault,
  operation: 'rollback-remove' | 'rollback-restore',
  rel: string,
  action: () => Promise<void>,
): Promise<void> => {
  await fault(operation, rel, 'before');
  await action();
  await fault(operation, rel, 'after');
};

const restoreBackup = async ({
  backup,
  backupIdentity,
  fault,
  target,
  transaction,
}: {
  readonly backup: PinnedTarget;
  readonly backupIdentity: NodeIdentity;
  readonly fault: MutationFault;
  readonly target: PinnedTarget;
  readonly transaction: PinnedDirectory;
}): Promise<void> => {
  await faulted(fault, 'rollback-restore', target.rel, () =>
    link(
      directoryEntryPath(backup.parent, backup.name),
      directoryEntryPath(target.parent, target.name),
    ),
  );
  await syncPinnedDirectory(target.parent);
  await unlinkPinnedIdentity({
    afterBind: () => fault('rollback-restore-bind', target.rel, 'after'),
    bindingName: rollbackBindingName(backup.name),
    expected: backupIdentity,
    message: `Recovery backup changed before cleanup: ${target.rel}`,
    target: backup,
    transaction,
  });
  await syncPinnedDirectory(transaction);
};

const removeInstalled = async ({
  bindingName,
  fault,
  installedIdentity,
  target,
  transaction,
}: {
  readonly bindingName: string;
  readonly fault: MutationFault;
  readonly installedIdentity: NodeIdentity;
  readonly target: PinnedTarget;
  readonly transaction: PinnedDirectory;
}): Promise<void> => {
  await fault('rollback-remove', target.rel, 'before');
  await unlinkPinnedIdentity({
    afterBind: () => fault('rollback-remove-bind', target.rel, 'after'),
    bindingName,
    expected: installedIdentity,
    message: `Recovery installed target changed before removal: ${target.rel}`,
    target,
    transaction,
  });
  await fault('rollback-remove', target.rel, 'after');
  await syncPinnedDirectory(target.parent);
  await syncPinnedDirectory(transaction);
};

const rollbackPresent = async ({
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
  const { backupState, backupTarget, bindingState, stageState, targetState } =
    await inspectPresentRollbackState(transaction, operation, target);
  if (
    await resumePresentRollbackBinding({
      backupState,
      backupTarget,
      bindingState,
      operation,
      restore: (backupIdentity) =>
        restoreBackup({
          backup: backupTarget,
          backupIdentity,
          fault,
          target,
          transaction,
        }),
      stageState,
      target,
      targetState,
      transaction,
    })
  ) {
    return;
  }
  if (backupState.contents === null) {
    if (!fileMatchesExpected(targetState, operation.before)) {
      throw new Error(`Recovery cannot find the prior file: ${operation.rel}`);
    }
    return;
  }
  if (!fileMatchesExpected(backupState, operation.before)) {
    throw new Error(
      `Recovery backup does not match preflight: ${operation.rel}`,
    );
  }
  if (fileMatchesExpected(targetState, operation.before)) {
    await cleanupRestoredBackup({
      backupState,
      backupTarget,
      operation,
      target,
      targetState,
      transaction,
    });
    return;
  }
  if (targetState.contents !== null) {
    if (
      stageState === null ||
      targetState.identity === null ||
      !identitiesMatch(targetState.identity, stageState.identity)
    ) {
      throw new Error(
        `Recovery found an unexpected replacement: ${operation.rel}`,
      );
    }
    if (targetState.identity === null) {
      throw new Error(
        `Recovery installed target has no identity: ${operation.rel}`,
      );
    }
    await removeInstalled({
      bindingName: rollbackBindingName(operation.backup),
      fault,
      installedIdentity: targetState.identity,
      target,
      transaction,
    });
  }
  if (backupState.identity === null) {
    throw new Error(`Recovery backup has no identity: ${operation.rel}`);
  }
  await restoreBackup({
    backup: backupTarget,
    backupIdentity: backupState.identity,
    fault,
    target,
    transaction,
  });
};

export const rollbackOperation = ({
  fault,
  operation,
  target,
  transaction,
}: {
  readonly fault: MutationFault;
  readonly operation: JournalOperation;
  readonly target: PinnedTarget;
  readonly transaction: PinnedDirectory;
}): Promise<void> =>
  operation.before.hash === null
    ? rollbackMissing(operation, target, transaction, fault)
    : rollbackPresent({ fault, operation, target, transaction });
