import type { PinnedDirectory, PinnedTarget } from './sync-directory-handles';
import type { NodeIdentity } from './sync-filesystem';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';
import { resolveRemovalEntryName } from './sync-transaction-quarantine-read';

export const rollbackBindingName = (
  backupName: string,
  phase: 'backup' | 'installed' = 'installed',
): string => `${backupName.replace('old-', 'rollback-')}-${phase}`;

export const rollbackBindingTarget = async (
  transaction: PinnedDirectory,
  backupName: string,
  rel: string,
  phase: 'backup' | 'installed' = 'installed',
): Promise<PinnedTarget> => ({
  name: await resolveRemovalEntryName(
    transaction,
    rollbackBindingName(backupName, phase),
  ),
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
  try {
    await bindAndRemoveEntry({
      afterBind,
      directory: transaction,
      expected,
      kind: 'file',
      name: bindingName,
      sourceDirectory: target.parent,
      sourceName: target.name,
    });
  } catch (error) {
    throw new Error(message, { cause: error });
  }
};
