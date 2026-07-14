import { readdir } from 'node:fs/promises';
import {
  type CreatedDirectory,
  directoryEntryPath,
  openPinnedChild,
  type PinnedDirectory,
  type PinnedTarget,
} from './sync-directory-handles';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';

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
    (left, right) => left.target.rel.length - right.target.rel.length,
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
          await assertDirectoryTreeEmpty(directory);
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

const assertDirectoryTreeEmpty = async (
  directory: PinnedDirectory,
): Promise<void> => {
  const entries = await readdir(directoryEntryPath(directory, '.'), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      throw new Error('Prune target is not empty');
    }
    // biome-ignore lint/performance/noAwaitInLoops: every descendant is pinned and validated before logical removal
    const child = await openPinnedChild(directory, entry.name);
    try {
      await assertDirectoryTreeEmpty(child);
    } finally {
      await child.handle.close();
    }
  }
};
