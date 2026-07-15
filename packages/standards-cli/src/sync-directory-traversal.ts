import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type CreatedDirectory,
  directoryEntryPath,
  openPinnedChild,
  openPinnedRoot,
  type PinnedDirectory,
  type PinnedTarget,
  syncPinnedDirectory,
} from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import { isMissingFilesystemError } from './sync-filesystem-error';
import type { MutationFault } from './sync-transaction-types';

const alreadyExists = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'EEXIST';
const noFault: MutationFault = () => Promise.resolve();

const openOrCreateChild = async ({
  afterCreate,
  create,
  fault,
  name,
  parent,
  rel,
}: {
  readonly afterCreate?: (child: PinnedDirectory) => Promise<void>;
  readonly create: boolean;
  readonly fault?: MutationFault;
  readonly name: string;
  readonly parent: PinnedDirectory;
  readonly rel: string;
}): Promise<{ readonly child: PinnedDirectory; readonly created: boolean }> => {
  const runFault = fault ?? noFault;
  try {
    return { child: await openPinnedChild(parent, name), created: false };
  } catch (openError) {
    if (!(create && isMissingFilesystemError(openError))) {
      throw openError;
    }
    let child: PinnedDirectory | undefined;
    let created = false;
    try {
      await runFault('mkdir', rel, 'before');
      await mkdir(directoryEntryPath(parent, name));
      created = true;
      child = await openPinnedChild(parent, name);
      await syncPinnedDirectory(parent);
      await afterCreate?.(child);
      await runFault('mkdir', rel, 'after');
      await runFault('mkdir-fsync', rel, 'after');
    } catch (mkdirError) {
      if (!alreadyExists(mkdirError)) {
        await child?.handle.close();
        throw mkdirError;
      }
    }
    return { child: child ?? (await openPinnedChild(parent, name)), created };
  }
};

const bindCreated = (
  afterCreate: Parameters<typeof pinTarget>[0]['afterCreate'],
  created: CreatedDirectory,
): ((directory: PinnedDirectory) => Promise<void>) | undefined =>
  afterCreate === undefined
    ? undefined
    : (directory) => afterCreate(created, directory);

export const pinTarget = async ({
  afterCreate,
  createParents,
  created,
  fault,
  opened,
  rel,
  root,
}: {
  readonly afterCreate?: (
    created: CreatedDirectory,
    directory: PinnedDirectory,
  ) => Promise<void>;
  readonly createParents: boolean;
  readonly created: Array<CreatedDirectory>;
  readonly fault?: MutationFault;
  readonly opened: Array<PinnedDirectory>;
  readonly rel: string;
  readonly root: RepositoryRoot;
}): Promise<PinnedTarget> => {
  const parentParts = dirname(rel)
    .split('/')
    .filter((part) => part !== '.');
  let parent = await openPinnedRoot(root);
  opened.push(parent);
  let parentRel = '';
  for (const part of parentParts) {
    parentRel = parentRel.length === 0 ? part : `${parentRel}/${part}`;
    const createdDirectory = { name: part, parent, rel: parentRel };
    // Components must be pinned in root-to-leaf order.
    // biome-ignore lint/performance/noAwaitInLoops: parallel traversal would open children through unpinned parents
    const child = await openOrCreateChild({
      afterCreate: bindCreated(afterCreate, createdDirectory),
      create: createParents,
      fault,
      name: part,
      parent,
      rel: parentRel,
    });
    if (child.created) {
      created.push(createdDirectory);
    }
    opened.push(child.child);
    parent = child.child;
  }
  return { name: rel.split('/').at(-1) ?? rel, parent, rel };
};
