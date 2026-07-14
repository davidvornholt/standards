import { unlink } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
  type PinnedTarget,
} from './sync-directory-handles';
import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import { renameNoReplace } from './sync-linux-rename';
import { inspectPinnedFile } from './sync-transaction-files';

export const rollbackBindingName = (backupName: string): string =>
  backupName.replace('old-', 'rollback-');

export const rollbackBindingTarget = (
  transaction: PinnedDirectory,
  backupName: string,
  rel: string,
): PinnedTarget => ({
  name: rollbackBindingName(backupName),
  parent: transaction,
  rel,
});

export const unlinkPinnedIdentity = async ({
  bindingName,
  afterBind,
  expected,
  message,
  target,
  transaction,
}: {
  readonly afterBind?: () => Promise<void>;
  readonly bindingName: string;
  readonly expected: NodeIdentity;
  readonly message: string;
  readonly target: PinnedTarget;
  readonly transaction: PinnedDirectory;
}): Promise<void> => {
  const binding = rollbackBindingTarget(transaction, bindingName, target.rel);
  const existingBinding = await inspectPinnedFile(binding);
  const createdBinding = existingBinding.identity === null;
  if (createdBinding) {
    renameNoReplace(
      target.parent.handle.fd,
      target.name,
      transaction.handle.fd,
      bindingName,
    );
    await afterBind?.();
  } else if ((await inspectPinnedFile(target)).identity !== null) {
    throw new Error(`Recovery unlink binding is occupied: ${target.rel}`);
  }
  const current = await inspectPinnedFile(binding);
  if (!identitiesMatch(expected, current.identity)) {
    if (createdBinding) {
      try {
        renameNoReplace(
          transaction.handle.fd,
          bindingName,
          target.parent.handle.fd,
          target.name,
        );
      } catch {
        // A concurrent target is preserved at its public name and the bound
        // replacement remains in the retained transaction directory.
      }
    }
    throw new Error(message);
  }
  await unlink(directoryEntryPath(transaction, bindingName));
};
