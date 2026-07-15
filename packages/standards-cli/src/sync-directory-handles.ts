import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import process from 'node:process';
import {
  identitiesMatch,
  identityOf,
  type RepositoryRoot,
} from './sync-filesystem';
import { assertNoReplaceRenameAvailable } from './sync-linux-rename';
import type { NodeIdentity } from './sync-node-identity';

export type PinnedDirectory = {
  readonly handle: FileHandle;
  readonly identity: NodeIdentity;
};

export type CreatedDirectory = {
  readonly name: string;
  readonly parent: PinnedDirectory;
  readonly rel: string;
};

export type PinnedTarget = {
  readonly name: string;
  readonly parent: PinnedDirectory;
  readonly rel: string;
};

export const descriptorRootForPlatform = (
  platform: NodeJS.Platform,
): '/proc/self/fd' | null => {
  if (platform === 'linux') {
    return '/proc/self/fd';
  }
  return null;
};

const descriptorRoot = descriptorRootForPlatform(process.platform);

export const directoryEntryPath = (
  directory: PinnedDirectory,
  name: string,
): string => {
  if (descriptorRoot === null) {
    throw new Error(
      `Safe standards filesystem mutations are unsupported on ${process.platform}`,
    );
  }
  return `${descriptorRoot}/${directory.handle.fd}/${name}`;
};

const openDirectory = async (path: string): Promise<PinnedDirectory> => {
  const handle = await open(
    path,
    constants.O_RDONLY + constants.O_DIRECTORY + constants.O_NOFOLLOW,
  );
  const info = await handle.stat({ bigint: true });
  if (!info.isDirectory()) {
    await handle.close();
    throw new Error(`Filesystem path must be a real directory: ${path}`);
  }
  return { handle, identity: identityOf(info) };
};

export const assertMutationPlatform = async (): Promise<void> => {
  if (descriptorRoot === null) {
    throw new Error(
      `Safe standards filesystem mutations are unsupported on ${process.platform}`,
    );
  }
  assertNoReplaceRenameAvailable();
  try {
    const probe = await openDirectory(descriptorRoot);
    await probe.handle.close();
  } catch (error) {
    throw new Error(
      'Safe standards filesystem mutations require Linux descriptor traversal through /proc/self/fd',
      { cause: error },
    );
  }
};

export const openPinnedRoot = async (
  root: RepositoryRoot,
): Promise<PinnedDirectory> => {
  const directory = await openDirectory(root.path);
  if (!identitiesMatch(root.identity, directory.identity)) {
    await directory.handle.close();
    throw new Error(`${root.label} root changed after preflight`);
  }
  return directory;
};

export const openPinnedChild = async (
  parent: PinnedDirectory,
  name: string,
): Promise<PinnedDirectory> => openDirectory(directoryEntryPath(parent, name));

export const closePinnedDirectories = async (
  directories: ReadonlyArray<PinnedDirectory>,
): Promise<void> => {
  await Promise.allSettled(
    [...new Set(directories.map(({ handle }) => handle))].map((handle) =>
      handle.close(),
    ),
  );
};

export const syncPinnedDirectory = async (
  directory: PinnedDirectory,
): Promise<void> => directory.handle.sync();
