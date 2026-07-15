import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { directoryEntryPath } from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import { nodeGeneration, nodeGenerationsMatch } from './sync-node-generation';
import {
  closeSourceDirectory,
  openSourceDirectory,
  openSourceRoot,
} from './sync-source-node';
import {
  assertSourceDirectoryRecord,
  openBoundSourceParent,
  sourceParentRel,
} from './sync-source-parent';
import type {
  SourceDirectoryRecord,
  SourceFileRecord,
  SourceSnapshotHooks,
} from './sync-source-types';

type ValidationContext = {
  readonly directories: ReadonlyMap<string, SourceDirectoryRecord>;
  readonly hooks: SourceSnapshotHooks;
  readonly ignoredNames: ReadonlySet<string>;
  readonly root: RepositoryRoot;
};

const validateDirectory = async (
  context: ValidationContext,
  record: SourceDirectoryRecord,
): Promise<void> => {
  if (record.rel === '') {
    const reopened = await openSourceRoot(
      context.root,
      context.ignoredNames,
      context.hooks,
    );
    try {
      assertSourceDirectoryRecord(record, reopened.record);
    } finally {
      await closeSourceDirectory(reopened, context.hooks);
    }
    return;
  }
  const parent = await openBoundSourceParent({
    hooks: context.hooks,
    ignoredNames: context.ignoredNames,
    records: context.directories,
    rel: sourceParentRel(record.rel),
    root: context.root,
  });
  const name = record.rel.split('/').at(-1) ?? record.rel;
  try {
    const reopened = await openSourceDirectory({
      hooks: context.hooks,
      ignoredNames: context.ignoredNames,
      name,
      parent: parent.directory,
      rel: record.rel,
    });
    try {
      assertSourceDirectoryRecord(record, reopened.record);
    } finally {
      await closeSourceDirectory(reopened, context.hooks);
    }
  } finally {
    await closeSourceDirectory(parent, context.hooks);
  }
};

const validateFile = async (
  context: ValidationContext,
  record: SourceFileRecord,
): Promise<void> => {
  const parent = await openBoundSourceParent({
    hooks: context.hooks,
    ignoredNames: context.ignoredNames,
    records: context.directories,
    rel: sourceParentRel(record.rel),
    root: context.root,
  });
  try {
    const name = record.rel.split('/').at(-1) ?? record.rel;
    const handle = await open(
      directoryEntryPath(parent.directory, name),
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
    );
    try {
      await context.hooks.afterFileOpen?.(record.rel);
      const current = await handle.stat({ bigint: true });
      if (
        !(
          current.isFile() &&
          nodeGenerationsMatch(record.generation, nodeGeneration(current))
        )
      ) {
        throw new Error(`Source file changed after inspection: ${record.rel}`);
      }
    } finally {
      await handle.close();
      await context.hooks.afterFileClose?.(record.rel);
    }
  } finally {
    await closeSourceDirectory(parent, context.hooks);
  }
};

export const validateSourceSnapshot = async ({
  directories,
  files,
  hooks,
  ignoredNames,
  root,
}: {
  readonly directories: ReadonlyMap<string, SourceDirectoryRecord>;
  readonly files: ReadonlyMap<string, SourceFileRecord>;
  readonly hooks: SourceSnapshotHooks;
  readonly ignoredNames: ReadonlySet<string>;
  readonly root: RepositoryRoot;
}): Promise<void> => {
  const rootRecord = directories.get('');
  if (rootRecord === undefined) {
    throw new Error('Source snapshot omitted its repository root');
  }
  const context = { directories, hooks, ignoredNames, root };
  await validateDirectory(context, rootRecord);
  for (const record of directories.values()) {
    if (record.rel !== '') {
      // biome-ignore lint/performance/noAwaitInLoops: sequential validation keeps descriptor usage depth-bounded
      await validateDirectory(context, record);
    }
  }
  for (const record of files.values()) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential validation keeps descriptor usage depth-bounded
    await validateFile(context, record);
  }
  await validateDirectory(context, rootRecord);
};
