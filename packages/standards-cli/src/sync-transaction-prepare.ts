import { rmdir } from 'node:fs/promises';
import {
  type CreatedDirectory,
  directoryEntryPath,
  type PinnedDirectory,
  type PinnedTarget,
  syncPinnedDirectory,
} from './sync-directory-handles';

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
  targets: ReadonlyArray<PinnedTarget>,
): Promise<void> => {
  const deepestFirst = [...targets].sort(
    (left, right) => right.rel.length - left.rel.length,
  );
  for (const target of deepestFirst) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: parents can become empty only after their children are pruned
      await rmdir(directoryEntryPath(target.parent, target.name));
      await syncPinnedDirectory(target.parent);
    } catch {
      // Pruning is best-effort; a non-empty directory remains repository-owned.
    }
  }
};
