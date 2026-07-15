import type { BigIntStats, Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  openPinnedChild,
  openPinnedRoot,
  type PinnedDirectory,
} from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import { isMissingFilesystemError } from './sync-filesystem-error';
import { nodeGeneration, nodeGenerationsMatch } from './sync-node-generation';
import type {
  OpenSourceDirectory,
  SourceDirectoryRecord,
  SourceSnapshotHooks,
} from './sync-source-types';

const filteredEntries = async (
  directory: PinnedDirectory,
  ignoredNames: ReadonlySet<string>,
): Promise<ReadonlyArray<string>> =>
  (await readdir(directoryEntryPath(directory, '.'), { withFileTypes: true }))
    .filter((entry: Dirent) => !ignoredNames.has(entry.name))
    .map((entry: Dirent) => entry.name)
    .sort((left: string, right: string) => left.localeCompare(right));

const captureOpenedDirectory = async (
  directory: PinnedDirectory,
  rel: string,
  ignoredNames: ReadonlySet<string>,
): Promise<SourceDirectoryRecord> => {
  const before = await directory.handle.stat({ bigint: true });
  if (!before.isDirectory()) {
    throw new Error(`Source path is not a directory: ${rel || '.'}`);
  }
  const entries = await filteredEntries(directory, ignoredNames);
  const after = await directory.handle.stat({ bigint: true });
  const generation = nodeGeneration(before);
  if (
    !(
      after.isDirectory() &&
      nodeGenerationsMatch(generation, nodeGeneration(after))
    )
  ) {
    throw new Error(
      `Source directory changed during inspection: ${rel || '.'}`,
    );
  }
  return { entries, generation, rel };
};

const assertObserved = (
  observed: BigIntStats | undefined,
  record: SourceDirectoryRecord,
): void => {
  if (
    observed !== undefined &&
    !nodeGenerationsMatch(nodeGeneration(observed), record.generation)
  ) {
    throw new Error(`Source path changed during inspection: ${record.rel}`);
  }
};

export const inspectSourceChild = async (
  parent: PinnedDirectory,
  name: string,
): Promise<BigIntStats | null> => {
  try {
    return await lstat(directoryEntryPath(parent, name), { bigint: true });
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      return null;
    }
    throw error;
  }
};

export const openSourceRoot = async (
  root: RepositoryRoot,
  ignoredNames: ReadonlySet<string>,
  hooks: SourceSnapshotHooks,
): Promise<OpenSourceDirectory> => {
  const directory = await openPinnedRoot(root);
  try {
    await hooks.afterDirectoryOpen?.('');
    return {
      directory,
      record: await captureOpenedDirectory(directory, '', ignoredNames),
    };
  } catch (error) {
    await directory.handle.close();
    await hooks.afterDirectoryClose?.('');
    throw error;
  }
};

export const openSourceDirectory = async ({
  expected,
  hooks,
  ignoredNames,
  name,
  parent,
  rel,
}: {
  readonly expected?: BigIntStats;
  readonly ignoredNames: ReadonlySet<string>;
  readonly hooks: SourceSnapshotHooks;
  readonly name: string;
  readonly parent: PinnedDirectory;
  readonly rel: string;
}): Promise<OpenSourceDirectory> => {
  const directory = await openPinnedChild(parent, name);
  try {
    await hooks.afterDirectoryOpen?.(rel);
    const record = await captureOpenedDirectory(directory, rel, ignoredNames);
    assertObserved(expected, record);
    return { directory, record };
  } catch (error) {
    await directory.handle.close();
    await hooks.afterDirectoryClose?.(rel);
    throw error;
  }
};

export const closeSourceDirectory = async (
  opened: OpenSourceDirectory,
  hooks: SourceSnapshotHooks,
): Promise<void> => {
  await opened.directory.handle.close();
  await hooks.afterDirectoryClose?.(opened.record.rel);
};

export const sourceDirectoryRecordsMatch = (
  left: SourceDirectoryRecord,
  right: SourceDirectoryRecord,
): boolean =>
  nodeGenerationsMatch(left.generation, right.generation) &&
  left.entries.length === right.entries.length &&
  left.entries.every((entry, index) => entry === right.entries[index]);
