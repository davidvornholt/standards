import type { PinnedDirectory, PinnedTarget } from './sync-directory-handles';
import { rollbackOperation } from './sync-transaction-rollback-operation';
import type {
  MutationFault,
  TransactionJournal,
} from './sync-transaction-types';

export const rollbackJournal = async ({
  fault,
  journal,
  targets,
  transaction,
}: {
  readonly fault: MutationFault;
  readonly journal: TransactionJournal;
  readonly targets: ReadonlyMap<string, PinnedTarget>;
  readonly transaction: PinnedDirectory;
}): Promise<ReadonlyArray<unknown>> => {
  const errors: Array<unknown> = [];
  for (const operation of [...journal.operations].reverse()) {
    const target = targets.get(operation.rel);
    if (target === undefined) {
      if (operation.before.hash !== null) {
        errors.push(
          new Error(`Recovery parent is unavailable: ${operation.rel}`),
        );
      }
    } else {
      try {
        // Inverse operations must remain ordered.
        // biome-ignore lint/performance/noAwaitInLoops: rollback is journal-ordered
        await rollbackOperation({
          fault,
          operation,
          target,
          transaction,
        });
      } catch (error) {
        errors.push(error);
      }
    }
  }
  return errors;
};
