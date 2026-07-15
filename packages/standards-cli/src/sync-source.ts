import {
  assertRepositoryRelativePath,
  type RepositoryRoot,
} from './sync-filesystem';
import { closeSourceDirectory, openSourceRoot } from './sync-source-node';
import { type SourceTraversal, walkSourceTree } from './sync-source-traversal';
import type { SourceFile, SourceSnapshotOptions } from './sync-source-types';
import { validateSourceSnapshot } from './sync-source-validation';

export type { SourceFile } from './sync-source-types';

export type RepositoryTreeSet = {
  readonly outputBase: string | null;
  readonly roots: ReadonlyArray<string>;
};

const assertTreeSets = (
  root: RepositoryRoot,
  sets: ReadonlyArray<RepositoryTreeSet>,
): void => {
  for (const { outputBase, roots } of sets) {
    if (outputBase !== null) {
      assertRepositoryRelativePath(outputBase, `${root.label} snapshot base`);
    }
    for (const rel of roots) {
      assertRepositoryRelativePath(rel, `${root.label} snapshot root`);
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
  assertTreeSets(root, sets);
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
