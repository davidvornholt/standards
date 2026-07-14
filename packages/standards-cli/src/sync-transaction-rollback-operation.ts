import { link, unlink } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
  type PinnedTarget,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch } from './sync-filesystem';
import {
  fileMatchesExpected,
  inspectPinnedFile,
} from './sync-transaction-files';
import type { JournalOperation, MutationFault } from './sync-transaction-types';

const artifact = (
  transaction: PinnedDirectory,
  name: string,
  rel: string,
): PinnedTarget => ({ name, parent: transaction, rel });

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

const sameFile = (
  left: Awaited<ReturnType<typeof inspectPinnedFile>>,
  right: Awaited<ReturnType<typeof inspectPinnedFile>>,
): boolean =>
  left.identity !== null && identitiesMatch(left.identity, right.identity);

const restoreBackup = async (
  target: PinnedTarget,
  backup: PinnedTarget,
  transaction: PinnedDirectory,
  fault: MutationFault,
): Promise<void> => {
  await faulted(fault, 'rollback-restore', target.rel, () =>
    link(
      directoryEntryPath(backup.parent, backup.name),
      directoryEntryPath(target.parent, target.name),
    ),
  );
  await syncPinnedDirectory(target.parent);
  await unlink(directoryEntryPath(backup.parent, backup.name));
  await syncPinnedDirectory(transaction);
};

const removeInstalled = async (
  target: PinnedTarget,
  transaction: PinnedDirectory,
  fault: MutationFault,
): Promise<void> => {
  await faulted(fault, 'rollback-remove', target.rel, () =>
    unlink(directoryEntryPath(target.parent, target.name)),
  );
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
  const backupTarget = artifact(transaction, operation.backup, operation.rel);
  const backupState = await inspectPinnedFile(backupTarget);
  if (backupState.contents === null) {
    const targetState = await inspectPinnedFile(target);
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
  const [targetState, stageState] = await Promise.all([
    inspectPinnedFile(target),
    operation.stage === null
      ? Promise.resolve(null)
      : inspectPinnedFile(
          artifact(transaction, operation.stage, operation.rel),
        ),
  ]);
  if (fileMatchesExpected(targetState, operation.before)) {
    if (!sameFile(targetState, backupState)) {
      throw new Error(
        `Recovery found two prior-file candidates: ${operation.rel}`,
      );
    }
    await syncPinnedDirectory(target.parent);
    await unlink(directoryEntryPath(transaction, operation.backup));
    await syncPinnedDirectory(transaction);
    return;
  }
  if (targetState.contents !== null) {
    if (stageState === null || !sameFile(targetState, stageState)) {
      throw new Error(
        `Recovery found an unexpected replacement: ${operation.rel}`,
      );
    }
    await removeInstalled(target, transaction, fault);
  }
  await restoreBackup(target, backupTarget, transaction, fault);
};

const rollbackMissing = async (
  operation: JournalOperation,
  target: PinnedTarget,
  transaction: PinnedDirectory,
  fault: MutationFault,
): Promise<void> => {
  const [backupState, targetState, stageState] = await Promise.all([
    inspectPinnedFile(artifact(transaction, operation.backup, operation.rel)),
    inspectPinnedFile(target),
    operation.stage === null
      ? Promise.resolve(null)
      : inspectPinnedFile(
          artifact(transaction, operation.stage, operation.rel),
        ),
  ]);
  if (backupState.contents !== null) {
    throw new Error(`Recovery found an impossible backup: ${operation.rel}`);
  }
  if (targetState.contents === null) {
    return;
  }
  if (stageState === null || !sameFile(targetState, stageState)) {
    throw new Error(
      `Recovery preserves an unexpected new file: ${operation.rel}`,
    );
  }
  await removeInstalled(target, transaction, fault);
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
