import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  type FileState,
  identitiesMatch,
  identityOf,
  inspectRepositoryNode,
  type RepositoryRoot,
} from './sync-filesystem';
import {
  type NodeGeneration,
  nodeGeneration,
  nodeGenerationsMatch,
} from './sync-node-generation';

const FILE_TYPE_MODE_BASE = 0o1000;

export type FileInspectionHooks = {
  readonly beforeRead?: (rel: string) => Promise<void>;
};

export type InspectedRepositoryFile = {
  readonly generation: NodeGeneration | null;
  readonly state: FileState;
};

export const inspectRepositoryFileWithGeneration = async (
  root: RepositoryRoot,
  rel: string,
  hooks: FileInspectionHooks = {},
): Promise<InspectedRepositoryFile> => {
  const node = await inspectRepositoryNode(root, rel);
  if (node.info === null) {
    return {
      generation: null,
      state: { contents: null, identity: null, mode: null },
    };
  }
  if (!node.info.isFile()) {
    throw new Error(`${root.label} path must be a regular file: ${rel}`);
  }
  const handle = await open(
    node.path,
    constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !(
        before.isFile() &&
        identitiesMatch(identityOf(node.info), identityOf(before))
      )
    ) {
      throw new Error(`${root.label} file changed during inspection: ${rel}`);
    }
    const beforeGeneration = nodeGeneration(before);
    await hooks.beforeRead?.(rel);
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !(
        after.isFile() &&
        nodeGenerationsMatch(beforeGeneration, nodeGeneration(after))
      )
    ) {
      throw new Error(`${root.label} file changed during inspection: ${rel}`);
    }
    return {
      generation: beforeGeneration,
      state: {
        contents,
        identity: identityOf(before),
        mode: Number(before.mode) % FILE_TYPE_MODE_BASE,
      },
    };
  } finally {
    await handle.close();
  }
};

export const inspectRepositoryFile = async (
  root: RepositoryRoot,
  rel: string,
): Promise<FileState> =>
  (await inspectRepositoryFileWithGeneration(root, rel)).state;

export const inspectRepositoryFiles = async (
  root: RepositoryRoot,
  rels: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, FileState>> =>
  new Map(
    await Promise.all(
      [...new Set(rels)].map(
        async (rel) => [rel, await inspectRepositoryFile(root, rel)] as const,
      ),
    ),
  );
