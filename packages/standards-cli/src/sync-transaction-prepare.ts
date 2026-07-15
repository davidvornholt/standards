import type {
  CreatedDirectory,
  PinnedDirectory,
  PinnedTarget,
} from './sync-directory-handles';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';
import { assertPruneTargetDirectlyEmpty } from './sync-transaction-prune-validation';

export const transactionTargetMap = (
  writes: ReadonlyArray<PinnedTarget>,
  deletes: ReadonlyArray<PinnedTarget>,
): ReadonlyMap<string, PinnedTarget> =>
  new Map([...writes, ...deletes].map((target) => [target.rel, target]));

export const assertPreparedParents = (
  planned: ReadonlyArray<string>,
  created: ReadonlyArray<CreatedDirectory>,
): void => {
  const actual = new Set(created.map(({ rel }) => rel));
  if (
    planned.length !== actual.size ||
    planned.some((rel) => !actual.has(rel))
  ) {
    throw new Error('Consumer parent directories changed after preflight');
  }
};

export const assertSingleFilesystem = (
  transaction: PinnedDirectory,
  targets: ReadonlyMap<string, PinnedTarget>,
): void => {
  const foreign = [...targets.values()].find(
    ({ parent }) => parent.identity.dev !== transaction.identity.dev,
  );
  if (foreign !== undefined) {
    throw new Error(
      `Transaction target crosses a filesystem boundary: ${foreign.rel}`,
    );
  }
};

export const applyPrunes = async (
  targets: ReadonlyArray<{
    readonly directory: PinnedDirectory;
    readonly target: PinnedTarget;
  }>,
): Promise<void> => {
  const deepestFirst = [...targets].sort(
    (left, right) =>
      right.target.rel.split('/').length - left.target.rel.split('/').length ||
      left.target.rel.localeCompare(right.target.rel),
  );
  for (const { directory, target } of deepestFirst) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: parents can become empty only after their children are pruned
      await bindAndRemoveEntry({
        directory: target.parent,
        expected: directory.identity,
        kind: 'directory',
        name: target.name,
        validateBound: async () => {
          await assertPruneTargetDirectlyEmpty(directory);
        },
      });
    } catch (error) {
      // Pruning is best-effort; a non-empty directory remains repository-owned.
      if (!String(error).includes('Prune target is not empty')) {
        throw error;
      }
    }
  }
};
