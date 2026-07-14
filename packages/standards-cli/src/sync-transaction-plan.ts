import { rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type CreatedDirectory,
  directoryEntryPath,
  openPinnedChild,
  type PinnedDirectory,
  type PinnedTarget,
} from './sync-directory-handles';
import { pinTarget } from './sync-directory-traversal';
import {
  identitiesMatch,
  inspectRepositoryNode,
  type PreparedDirectory,
  type RepositoryRoot,
} from './sync-filesystem';
import {
  assertPinnedDirectoryUnchanged,
  assertPinnedFileUnchanged,
  type TransactionWrite,
} from './sync-transaction-files';
import type { MutationFault } from './sync-transaction-types';

export type TransactionDelete = {
  readonly before: TransactionWrite['before'];
  readonly rel: string;
};

export const assertParentsLinked = async (
  root: RepositoryRoot,
  targets: ReadonlyArray<PinnedTarget>,
): Promise<void> => {
  const nested = targets.filter(({ rel }) => dirname(rel) !== '.');
  await Promise.all(
    nested.map(async ({ parent, rel }) => {
      const parentRel = dirname(rel);
      const node = await inspectRepositoryNode(root, parentRel);
      if (
        node.info === null ||
        !node.info.isDirectory() ||
        !identitiesMatch(parent.identity, {
          dev: node.info.dev,
          ino: node.info.ino,
        })
      ) {
        throw new Error(
          `Consumer parent changed after preflight: ${parentRel}`,
        );
      }
    }),
  );
};

export const prepareTargets = async ({
  afterCreate,
  created,
  deletes,
  fault,
  opened,
  root,
  writes,
}: {
  readonly afterCreate?: Parameters<typeof pinTarget>[0]['afterCreate'];
  readonly created: Array<CreatedDirectory>;
  readonly deletes: ReadonlyArray<TransactionDelete>;
  readonly fault?: MutationFault;
  readonly opened: Array<PinnedDirectory>;
  readonly root: RepositoryRoot;
  readonly writes: ReadonlyArray<TransactionWrite>;
}): Promise<{
  readonly deletes: ReadonlyArray<PinnedTarget>;
  readonly writes: ReadonlyArray<PinnedTarget>;
}> => {
  const writeTargets = await Promise.all(
    writes.map((write) =>
      pinTarget({
        afterCreate,
        createParents: true,
        created,
        fault,
        opened,
        rel: write.rel,
        root,
      }),
    ),
  );
  const deleteTargets = await Promise.all(
    deletes.map((deletion) =>
      pinTarget({
        createParents: false,
        created,
        opened,
        rel: deletion.rel,
        root,
      }),
    ),
  );
  await Promise.all([
    ...writes.map((write, index) =>
      assertPinnedFileUnchanged(
        writeTargets[index] as PinnedTarget,
        write.before,
      ),
    ),
    ...deletes.map((deletion, index) =>
      assertPinnedFileUnchanged(
        deleteTargets[index] as PinnedTarget,
        deletion.before,
      ),
    ),
  ]);
  return { deletes: deleteTargets, writes: writeTargets };
};

export const preparePrunes = async (
  root: RepositoryRoot,
  prunes: ReadonlyArray<PreparedDirectory>,
  opened: Array<PinnedDirectory>,
  created: Array<CreatedDirectory>,
): Promise<ReadonlyArray<PinnedTarget>> => {
  const targets = await Promise.all(
    prunes.map((prune) =>
      pinTarget({
        createParents: false,
        created,
        opened,
        rel: prune.rel,
        root,
      }),
    ),
  );
  await Promise.all(
    targets.map(async (target, index) => {
      const directory = await openPinnedChild(target.parent, target.name);
      opened.push(directory);
      await assertPinnedDirectoryUnchanged(
        directory,
        (prunes[index] as PreparedDirectory).identity,
        target.rel,
      );
    }),
  );
  return targets;
};

export const removeCreatedDirectories = async (
  created: ReadonlyArray<CreatedDirectory>,
): Promise<void> => {
  await Promise.allSettled(
    [...created]
      .sort((left, right) => right.rel.length - left.rel.length)
      .map(({ name, parent }) => rmdir(directoryEntryPath(parent, name))),
  );
};
