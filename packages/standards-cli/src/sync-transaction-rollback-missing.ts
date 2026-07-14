import {
  type PinnedDirectory,
  type PinnedTarget,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch } from './sync-filesystem';
import {
  rollbackBindingName,
  rollbackBindingTarget,
  unlinkPinnedIdentity,
} from './sync-transaction-bound-unlink';
import { inspectPinnedFile } from './sync-transaction-files';
import type { JournalOperation, MutationFault } from './sync-transaction-types';

export const rollbackMissing = async (
  operation: JournalOperation,
  target: PinnedTarget,
  transaction: PinnedDirectory,
  fault: MutationFault,
): Promise<void> => {
  const artifact = (name: string): PinnedTarget => ({
    name,
    parent: transaction,
    rel: operation.rel,
  });
  const bindingTarget = await rollbackBindingTarget(
    transaction,
    operation.backup,
    operation.rel,
  );
  const [backupState, bindingState, targetState, stageState] =
    await Promise.all([
      inspectPinnedFile(artifact(operation.backup)),
      inspectPinnedFile(bindingTarget),
      inspectPinnedFile(target),
      operation.stage === null
        ? Promise.resolve(null)
        : inspectPinnedFile(artifact(operation.stage)),
    ]);
  if (backupState.contents !== null) {
    throw new Error(`Recovery found an impossible backup: ${operation.rel}`);
  }
  if (bindingState.identity !== null) {
    if (stageState?.identity === null || stageState?.identity === undefined) {
      throw new Error(
        `Recovery rollback binding has no expected stage: ${operation.rel}`,
      );
    }
    await unlinkPinnedIdentity({
      bindingName: rollbackBindingName(operation.backup),
      expected: stageState.identity,
      message: `Recovery installed target binding changed: ${operation.rel}`,
      target,
      transaction,
    });
    await syncPinnedDirectory(target.parent);
    await syncPinnedDirectory(transaction);
    return;
  }
  if (targetState.contents === null) {
    return;
  }
  if (
    stageState === null ||
    targetState.identity === null ||
    !identitiesMatch(targetState.identity, stageState.identity)
  ) {
    throw new Error(
      `Recovery preserves an unexpected new file: ${operation.rel}`,
    );
  }
  await fault('rollback-remove', target.rel, 'before');
  await unlinkPinnedIdentity({
    afterBind: () => fault('rollback-remove-bind', target.rel, 'after'),
    bindingName: rollbackBindingName(operation.backup),
    expected: targetState.identity,
    message: `Recovery installed target changed before removal: ${target.rel}`,
    target,
    transaction,
  });
  await fault('rollback-remove', target.rel, 'after');
  await syncPinnedDirectory(target.parent);
  await syncPinnedDirectory(transaction);
};
