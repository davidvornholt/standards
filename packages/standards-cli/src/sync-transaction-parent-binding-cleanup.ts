import type { PinnedDirectory } from './sync-directory-handles';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';
import {
  type CreatedParentBinding,
  createdParentBindingName,
} from './sync-transaction-parent-binding';
import type { TransactionJournal } from './sync-transaction-types';

export const removeParentBinding = async ({
  binding,
  hooks = {},
  index,
  journal,
  root,
}: {
  readonly binding: CreatedParentBinding;
  readonly hooks?: {
    readonly afterSync?: () => Promise<void>;
    readonly afterUnlink?: () => Promise<void>;
  };
  readonly index: number;
  readonly journal: TransactionJournal;
  readonly root: PinnedDirectory;
}): Promise<void> => {
  await bindAndRemoveEntry({
    afterRemove: hooks.afterUnlink,
    directory: root,
    expected: binding.file,
    kind: 'file',
    name: createdParentBindingName(journal.id, index),
  });
  await hooks.afterSync?.();
};
