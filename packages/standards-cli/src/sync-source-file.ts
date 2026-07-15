import { type BigIntStats, constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import { nodeGeneration, nodeGenerationsMatch } from './sync-node-generation';
import type {
  SourceFileRecord,
  SourceSnapshotHooks,
} from './sync-source-types';

const FILE_TYPE_MODE_BASE = 0o1000;

export const captureSourceFile = async ({
  expected,
  hooks,
  name,
  parent,
  rel,
}: {
  readonly expected: BigIntStats;
  readonly hooks: SourceSnapshotHooks;
  readonly name: string;
  readonly parent: PinnedDirectory;
  readonly rel: string;
}): Promise<SourceFileRecord> => {
  const handle = await open(
    directoryEntryPath(parent, name),
    constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  );
  try {
    await hooks.afterFileOpen?.(rel);
    const before = await handle.stat({ bigint: true });
    const generation = nodeGeneration(before);
    if (
      !(
        before.isFile() &&
        nodeGenerationsMatch(nodeGeneration(expected), generation)
      )
    ) {
      throw new Error(`Source path changed during inspection: ${rel}`);
    }
    await hooks.beforeFileRead?.(rel);
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !(
        after.isFile() &&
        nodeGenerationsMatch(generation, nodeGeneration(after))
      )
    ) {
      throw new Error(`Source file changed during inspection: ${rel}`);
    }
    await hooks.afterFileRead?.(rel);
    return {
      contents,
      generation,
      mode: Number(before.mode) % FILE_TYPE_MODE_BASE,
      rel,
    };
  } finally {
    await handle.close();
    await hooks.afterFileClose?.(rel);
  }
};
