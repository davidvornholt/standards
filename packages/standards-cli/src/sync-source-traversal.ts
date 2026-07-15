import { relative, sep } from 'node:path';
import {
  assertRepositoryRelativePath,
  type RepositoryRoot,
} from './sync-filesystem';
import { nodeGenerationsMatch } from './sync-node-generation';
import { captureSourceFile } from './sync-source-file';
import {
  closeSourceDirectory,
  inspectSourceChild,
  openSourceDirectory,
} from './sync-source-node';
import {
  openCaptureSourceParent,
  recordSourceDirectory,
  sourceParentRel,
} from './sync-source-parent';
import type {
  OpenSourceDirectory,
  SourceDirectoryRecord,
  SourceFile,
  SourceFileExpectation,
  SourceFileRecord,
  SourceSnapshotHooks,
} from './sync-source-types';

export type SourceTraversal = {
  readonly directories: Map<string, SourceDirectoryRecord>;
  readonly expectedFiles: ReadonlyMap<string, SourceFileExpectation>;
  readonly files: Map<string, SourceFileRecord>;
  readonly hooks: SourceSnapshotHooks;
  readonly ignoredNames: ReadonlySet<string>;
  readonly root: RepositoryRoot;
  readonly rootDirectory: OpenSourceDirectory;
};

const assertExpectedFile = (
  traversal: SourceTraversal,
  record: SourceFileRecord,
): void => {
  const expected = traversal.expectedFiles.get(record.rel);
  if (
    expected !== undefined &&
    !(
      nodeGenerationsMatch(expected.generation, record.generation) &&
      expected.contents.equals(record.contents)
    )
  ) {
    throw new Error(`Source file changed after it was selected: ${record.rel}`);
  }
};

const recordSourceFile = (
  traversal: SourceTraversal,
  record: SourceFileRecord,
): void => {
  const previous = traversal.files.get(record.rel);
  if (
    previous !== undefined &&
    !(
      nodeGenerationsMatch(previous.generation, record.generation) &&
      previous.contents.equals(record.contents)
    )
  ) {
    throw new Error(`Source file changed during inspection: ${record.rel}`);
  }
  assertExpectedFile(traversal, record);
  traversal.files.set(record.rel, record);
};

const walkChild = async ({
  output,
  outputBase,
  parent,
  rel,
  traversal,
}: {
  readonly output: Map<string, SourceFile>;
  readonly outputBase: string | null;
  readonly parent: OpenSourceDirectory;
  readonly rel: string;
  readonly traversal: SourceTraversal;
}): Promise<void> => {
  const name = rel.split('/').at(-1) ?? rel;
  const observed = await inspectSourceChild(parent.directory, name);
  if (observed === null) {
    return;
  }
  if (observed.isSymbolicLink()) {
    throw new Error(
      `${traversal.root.label} path must not be a symbolic link: ${rel}`,
    );
  }
  if (observed.isFile()) {
    const record = await captureSourceFile({
      expected: observed,
      hooks: traversal.hooks,
      name,
      parent: parent.directory,
      rel,
    });
    recordSourceFile(traversal, record);
    const outputPath = relative(outputBase ?? '', rel)
      .split(sep)
      .join('/');
    assertRepositoryRelativePath(
      outputPath,
      `${traversal.root.label} snapshot file`,
    );
    output.set(outputPath, { contents: record.contents, mode: record.mode });
    return;
  }
  if (!observed.isDirectory()) {
    throw new Error(
      `${traversal.root.label} contains an unsupported node: ${rel}`,
    );
  }
  const opened = await openSourceDirectory({
    expected: observed,
    hooks: traversal.hooks,
    ignoredNames: traversal.ignoredNames,
    name,
    parent: parent.directory,
    rel,
  });
  try {
    recordSourceDirectory(traversal.directories, opened.record);
    for (const entry of opened.record.entries) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential descent bounds descriptors by source depth and quiesces siblings before cleanup
      await walkChild({
        output,
        outputBase,
        parent: opened,
        rel: `${rel}/${entry}`,
        traversal,
      });
    }
  } finally {
    await closeSourceDirectory(opened, traversal.hooks);
  }
};

export const walkSourceTree = async (
  traversal: SourceTraversal,
  rel: string,
  outputBase: string | null,
  output: Map<string, SourceFile>,
): Promise<void> => {
  const parent = await openCaptureSourceParent({
    directories: traversal.directories,
    hooks: traversal.hooks,
    ignoredNames: traversal.ignoredNames,
    rel: sourceParentRel(rel),
    rootDirectory: traversal.rootDirectory,
  });
  if (parent.missing) {
    return;
  }
  try {
    await walkChild({
      output,
      outputBase,
      parent: parent.opened,
      rel,
      traversal,
    });
  } finally {
    if (parent.close) {
      await closeSourceDirectory(parent.opened, traversal.hooks);
    }
  }
};
