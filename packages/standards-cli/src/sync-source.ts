import {
  assertRepositoryRelativePath,
  type RepositoryRoot,
} from './sync-filesystem';
import { closeSourceDirectory, openSourceRoot } from './sync-source-node';
import { type SourceTraversal, walkSourceTree } from './sync-source-traversal';
import type { SourceFile, SourceSnapshotOptions } from './sync-source-types';
import { validateSourceSnapshot } from './sync-source-validation';

export type { SourceFile } from './sync-source-types';

// Build output, VCS metadata, and installed dependencies would pollute the lock
// when syncing from a working tree that has them. Ordinary enumeration filters
// these names, while explicit roots and output bases fail closed.
export const IGNORED_SOURCE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  '.next',
]);

export type RepositoryTreeSet = {
  readonly outputBase: string | null;
  readonly roots: ReadonlyArray<string>;
};

const assertTreeSets = (
  root: RepositoryRoot,
  sets: ReadonlyArray<RepositoryTreeSet>,
  ignoredNames: ReadonlySet<string>,
): void => {
  const assertNoIgnoredComponent = (path: string, label: string): void => {
    const ignored = path.split('/').find((part) => ignoredNames.has(part));
    if (ignored !== undefined) {
      throw new Error(
        `${label} must not contain ignored path component "${ignored}": ${path}`,
      );
    }
  };
  for (const { outputBase, roots } of sets) {
    if (outputBase !== null) {
      const label = `${root.label} snapshot base`;
      assertRepositoryRelativePath(outputBase, label);
      assertNoIgnoredComponent(outputBase, label);
    }
    for (const rel of roots) {
      const label = `${root.label} snapshot root`;
      assertRepositoryRelativePath(rel, label);
      assertNoIgnoredComponent(rel, label);
    }
  }
};

const assertExpectedFilesCaptured = (traversal: SourceTraversal): void => {
  for (const rel of traversal.expectedFiles.keys()) {
    if (!traversal.files.has(rel)) {
      throw new Error(`Selected source does not manage required file: ${rel}`);
    }
  }
};

export const snapshotRepositoryTreeSets = async (
  root: RepositoryRoot,
  sets: ReadonlyArray<RepositoryTreeSet>,
  ignoredNames: ReadonlySet<string>,
  options: SourceSnapshotOptions = {},
): Promise<ReadonlyArray<ReadonlyMap<string, SourceFile>>> => {
  assertTreeSets(root, sets, ignoredNames);
  const hooks = options.hooks ?? {};
  const rootDirectory = await openSourceRoot(root, ignoredNames, hooks);
  const traversal: SourceTraversal = {
    directories: new Map([['', rootDirectory.record]]),
    expectedFiles: options.expectedFiles ?? new Map(),
    files: new Map(),
    hooks,
    ignoredNames,
    root,
    rootDirectory,
  };
  const outputs = sets.map(() => new Map<string, SourceFile>());
  try {
    for (const [index, { outputBase, roots }] of sets.entries()) {
      const output = outputs[index] as Map<string, SourceFile>;
      for (const rel of roots) {
        // biome-ignore lint/performance/noAwaitInLoops: one global sequential capture bounds descriptors and prevents sibling cleanup races
        await walkSourceTree(traversal, rel, outputBase, output);
      }
    }
    assertExpectedFilesCaptured(traversal);
    await traversal.hooks.beforeFinalValidation?.();
    await validateSourceSnapshot({
      directories: traversal.directories,
      files: traversal.files,
      hooks,
      ignoredNames,
      root,
    });
    return outputs;
  } finally {
    await closeSourceDirectory(rootDirectory, hooks);
  }
};
