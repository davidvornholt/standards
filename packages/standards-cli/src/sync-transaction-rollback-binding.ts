import {
  type PinnedDirectory,
  type PinnedTarget,
  syncPinnedDirectory,
} from './sync-directory-handles';
import type { FileState, NodeIdentity } from './sync-filesystem';
import {
  rollbackBindingTarget,
  unlinkPinnedIdentity,
} from './sync-transaction-bound-unlink';
import {
  fileMatchesExpected,
  inspectPinnedFile,
} from './sync-transaction-files';
import type { JournalOperation } from './sync-transaction-types';

export const inspectPresentRollbackState = async (
  transaction: PinnedDirectory,
  operation: JournalOperation,
  target: PinnedTarget,
) => {
  const artifact = (name: string): PinnedTarget => ({
    name,
    parent: transaction,
    rel: operation.rel,
  });
  const backupTarget = artifact(operation.backup);
  const [backupState, bindingState, targetState, stageState] =
    await Promise.all([
      inspectPinnedFile(backupTarget),
      inspectPinnedFile(
        rollbackBindingTarget(transaction, operation.backup, operation.rel),
      ),
      inspectPinnedFile(target),
      operation.stage === null
        ? Promise.resolve(null)
        : inspectPinnedFile(artifact(operation.stage)),
    ]);
  return { backupState, backupTarget, bindingState, stageState, targetState };
};

export const resumePresentRollbackBinding = async ({
  backupState,
  backupTarget,
  bindingState,
  operation,
  stageState,
  target,
  targetState,
  transaction,
  restore,
}: {
  readonly backupState: FileState;
  readonly backupTarget: PinnedTarget;
  readonly bindingState: FileState;
  readonly operation: JournalOperation;
  readonly stageState: FileState | null;
  readonly target: PinnedTarget;
  readonly targetState: FileState;
  readonly transaction: PinnedDirectory;
  readonly restore: (backupIdentity: NodeIdentity) => Promise<void>;
}): Promise<boolean> => {
  if (bindingState.identity === null) {
    return false;
  }
  const bindingTarget = rollbackBindingTarget(
    transaction,
    operation.backup,
    operation.rel,
  );
  if (
    backupState.contents === null &&
    fileMatchesExpected(targetState, operation.before) &&
    targetState.identity !== null
  ) {
    await unlinkPinnedIdentity({
      bindingName: bindingTarget.name,
      expected: targetState.identity,
      message: `Recovery backup binding changed: ${operation.rel}`,
      target: backupTarget,
      transaction,
    });
    await syncPinnedDirectory(transaction);
    return true;
  }
  if (
    fileMatchesExpected(backupState, operation.before) &&
    targetState.contents === null &&
    stageState !== null &&
    stageState.identity !== null
  ) {
    await unlinkPinnedIdentity({
      bindingName: bindingTarget.name,
      expected: stageState.identity,
      message: `Recovery installed target binding changed: ${operation.rel}`,
      target,
      transaction,
    });
    await syncPinnedDirectory(target.parent);
    await syncPinnedDirectory(transaction);
    if (backupState.identity === null) {
      throw new Error(`Recovery backup has no identity: ${operation.rel}`);
    }
    await restore(backupState.identity);
    return true;
  }
  throw new Error(
    `Recovery rollback binding is inconsistent: ${operation.rel}`,
  );
};
