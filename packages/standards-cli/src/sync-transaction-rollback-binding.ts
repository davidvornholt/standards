import type { PinnedDirectory, PinnedTarget } from './sync-directory-handles';
import type { FileState, NodeIdentity } from './sync-filesystem';
import { rollbackBindingTarget } from './sync-transaction-bound-unlink';
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
  const [installedBinding, backupBinding] = await Promise.all([
    rollbackBindingTarget(transaction, operation.backup, operation.rel),
    rollbackBindingTarget(
      transaction,
      operation.backup,
      operation.rel,
      'backup',
    ),
  ]);
  const [
    backupState,
    installedBindingState,
    backupBindingState,
    targetState,
    stageState,
  ] = await Promise.all([
    inspectPinnedFile(backupTarget),
    inspectPinnedFile(installedBinding),
    inspectPinnedFile(backupBinding),
    inspectPinnedFile(target),
    operation.stage === null
      ? Promise.resolve(null)
      : inspectPinnedFile(artifact(operation.stage)),
  ]);
  return {
    backupBindingState,
    backupState,
    backupTarget,
    installedBindingState,
    stageState,
    targetState,
  };
};

export const resumePresentRollbackBinding = async ({
  backupState,
  backupBindingState,
  installedBindingState,
  operation,
  stageState,
  targetState,
  restore,
}: {
  readonly backupState: FileState;
  readonly backupBindingState: FileState;
  readonly installedBindingState: FileState;
  readonly operation: JournalOperation;
  readonly stageState: FileState | null;
  readonly targetState: FileState;
  readonly restore: (backupIdentity: NodeIdentity) => Promise<void>;
}): Promise<boolean> => {
  if (
    backupBindingState.identity !== null &&
    backupState.contents === null &&
    fileMatchesExpected(targetState, operation.before) &&
    targetState.identity !== null
  ) {
    return true;
  }
  if (
    installedBindingState.identity !== null &&
    fileMatchesExpected(backupState, operation.before) &&
    targetState.contents === null &&
    stageState !== null &&
    stageState.identity !== null
  ) {
    if (backupState.identity === null) {
      throw new Error(`Recovery backup has no identity: ${operation.rel}`);
    }
    await restore(backupState.identity);
    return true;
  }
  if (
    backupBindingState.identity === null &&
    installedBindingState.identity === null
  ) {
    return false;
  }
  throw new Error(
    `Recovery rollback binding is inconsistent: ${operation.rel}`,
  );
};
