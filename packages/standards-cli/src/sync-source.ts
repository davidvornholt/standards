import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  assertRepositoryRelativePath,
  identitiesMatch,
  inspectRepositoryFile,
  inspectRepositoryNode,
  type RepositoryRoot,
} from './sync-filesystem';

export type SourceFile = {
  readonly contents: Buffer;
  readonly mode: number;
};

const requiredSourceFile = async (
  root: RepositoryRoot,
  rel: string,
): Promise<SourceFile> => {
  const state = await inspectRepositoryFile(root, rel);
  if (state.contents === null || state.mode === null) {
    throw new Error(`${root.label} file disappeared during inspection: ${rel}`);
  }
  return { contents: state.contents, mode: state.mode };
};

export const snapshotRepositoryTrees = async (
  root: RepositoryRoot,
  roots: ReadonlyArray<string>,
  outputBase: string | null,
  ignoredNames: ReadonlySet<string>,
): Promise<ReadonlyMap<string, SourceFile>> => {
  if (outputBase !== null) {
    assertRepositoryRelativePath(outputBase, `${root.label} snapshot base`);
  }
  const output = new Map<string, SourceFile>();
  const base = outputBase === null ? root.path : join(root.path, outputBase);
  const walk = async (rel: string): Promise<void> => {
    const node = await inspectRepositoryNode(root, rel);
    if (node.info === null) {
      return;
    }
    if (node.info.isFile()) {
      const outputPath = relative(base, node.path).split(sep).join('/');
      assertRepositoryRelativePath(outputPath, `${root.label} snapshot file`);
      output.set(outputPath, await requiredSourceFile(root, rel));
      return;
    }
    if (!node.info.isDirectory()) {
      throw new Error(`${root.label} contains an unsupported node: ${rel}`);
    }
    const entries = (await readdir(node.path)).filter(
      (entry) => !ignoredNames.has(entry),
    );
    await Promise.all(entries.map((entry) => walk(`${rel}/${entry}`)));
    const after = await inspectRepositoryNode(root, rel);
    if (
      after.info === null ||
      !after.info.isDirectory() ||
      !identitiesMatch(
        { dev: node.info.dev, ino: node.info.ino },
        { dev: after.info.dev, ino: after.info.ino },
      )
    ) {
      throw new Error(
        `${root.label} directory changed during inspection: ${rel}`,
      );
    }
  };
  await Promise.all(roots.map(walk));
  return output;
};
