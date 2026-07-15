import type { RepositoryRoot } from './sync-filesystem';
import {
  closeSourceDirectory,
  inspectSourceChild,
  openSourceDirectory,
  openSourceRoot,
  sourceDirectoryRecordsMatch,
} from './sync-source-node';
import type {
  OpenSourceDirectory,
  SourceDirectoryRecord,
  SourceSnapshotHooks,
} from './sync-source-types';

export const sourceParentRel = (rel: string): string => {
  const parts = rel.split('/');
  parts.pop();
  return parts.join('/');
};

export const recordSourceDirectory = (
  records: Map<string, SourceDirectoryRecord>,
  record: SourceDirectoryRecord,
): void => {
  const previous = records.get(record.rel);
  if (
    previous !== undefined &&
    !sourceDirectoryRecordsMatch(previous, record)
  ) {
    throw new Error(
      `Source directory changed during inspection: ${record.rel}`,
    );
  }
  records.set(record.rel, record);
};

export const assertSourceDirectoryRecord = (
  expected: SourceDirectoryRecord | undefined,
  actual: SourceDirectoryRecord,
): void => {
  if (
    expected === undefined ||
    !sourceDirectoryRecordsMatch(expected, actual)
  ) {
    throw new Error(
      `Source directory changed after inspection: ${actual.rel || '.'}`,
    );
  }
};

const missingCaptureParent = async (
  current: OpenSourceDirectory,
  currentIsRoot: boolean,
  hooks: SourceSnapshotHooks,
): Promise<{ readonly missing: true }> => {
  if (!currentIsRoot) {
    await closeSourceDirectory(current, hooks);
  }
  return { missing: true };
};

export const openCaptureSourceParent = async ({
  directories,
  hooks,
  ignoredNames,
  rel,
  rootDirectory,
}: {
  readonly directories: Map<string, SourceDirectoryRecord>;
  readonly hooks: SourceSnapshotHooks;
  readonly ignoredNames: ReadonlySet<string>;
  readonly rel: string;
  readonly rootDirectory: OpenSourceDirectory;
}): Promise<
  | {
      readonly close: boolean;
      readonly missing: false;
      readonly opened: OpenSourceDirectory;
    }
  | { readonly missing: true }
> => {
  if (rel === '') {
    return { close: false, missing: false, opened: rootDirectory };
  }
  let current = rootDirectory;
  let currentIsRoot = true;
  const parts = rel.split('/');
  try {
    for (const [index, name] of parts.entries()) {
      const component = parts.slice(0, index + 1).join('/');
      // biome-ignore lint/performance/noAwaitInLoops: safe descriptor traversal is necessarily ordered by path component
      const observed = await inspectSourceChild(current.directory, name);
      if (observed === null) {
        return missingCaptureParent(current, current === rootDirectory, hooks);
      }
      if (!observed.isDirectory()) {
        throw new Error(`Source parent is not a directory: ${component}`);
      }
      const next = await openSourceDirectory({
        expected: observed,
        hooks,
        ignoredNames,
        name,
        parent: current.directory,
        rel: component,
      });
      try {
        recordSourceDirectory(directories, next.record);
      } catch (error) {
        await closeSourceDirectory(next, hooks);
        throw error;
      }
      const previous = current;
      const previousIsRoot = currentIsRoot;
      current = next;
      currentIsRoot = false;
      if (!previousIsRoot) {
        await closeSourceDirectory(previous, hooks);
      }
    }
    return { close: true, missing: false, opened: current };
  } catch (error) {
    if (!currentIsRoot) {
      await closeSourceDirectory(current, hooks);
    }
    throw error;
  }
};

export const openBoundSourceParent = async ({
  hooks,
  ignoredNames,
  records,
  rel,
  root,
}: {
  readonly hooks: SourceSnapshotHooks;
  readonly ignoredNames: ReadonlySet<string>;
  readonly records: ReadonlyMap<string, SourceDirectoryRecord>;
  readonly rel: string;
  readonly root: RepositoryRoot;
}): Promise<OpenSourceDirectory> => {
  let current = await openSourceRoot(root, ignoredNames, hooks);
  const parts = rel.split('/').filter(Boolean);
  try {
    assertSourceDirectoryRecord(records.get(''), current.record);
    for (const [index, name] of parts.entries()) {
      const component = parts.slice(0, index + 1).join('/');
      // biome-ignore lint/performance/noAwaitInLoops: final rebinding must follow the path one descriptor at a time
      const next = await openSourceDirectory({
        hooks,
        ignoredNames,
        name,
        parent: current.directory,
        rel: component,
      });
      try {
        assertSourceDirectoryRecord(records.get(component), next.record);
      } catch (error) {
        await closeSourceDirectory(next, hooks);
        throw error;
      }
      const previous = current;
      current = next;
      await closeSourceDirectory(previous, hooks);
    }
    return current;
  } catch (error) {
    await closeSourceDirectory(current, hooks);
    throw error;
  }
};
