import { constants } from 'node:fs';
import { open, readdir, rmdir, unlink } from 'node:fs/promises';
import {
  directoryEntryPath,
  openPinnedChild,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import {
  identitiesMatch,
  identityOf,
  type NodeIdentity,
} from './sync-filesystem';
import { renameDirectoryNoReplace } from './sync-linux-rename';

export const REMOVAL_BINDING_PREFIX = '.standards-removal-';
const IDENTITY_SUFFIX = /^(?<dev>0|[1-9]\d*)-(?<ino>0|[1-9]\d*)$/u;
const REMOVAL_BINDING =
  /^(?<encoded>[A-Za-z0-9_-]+)-(?<dev>0|[1-9]\d*)-(?<ino>0|[1-9]\d*)$/u;
const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

const bindingPrefix = (name: string): string =>
  `${REMOVAL_BINDING_PREFIX}${Buffer.from(name).toString('base64url')}-`;

export const removalBindingName = (
  name: string,
  identity: NodeIdentity,
): string => `${bindingPrefix(name)}${identity.dev}-${identity.ino}`;

const parseIdentity = (
  name: string,
  candidate: string,
): NodeIdentity | null => {
  const prefix = bindingPrefix(name);
  if (!candidate.startsWith(prefix)) {
    return null;
  }
  const match = IDENTITY_SUFFIX.exec(candidate.slice(prefix.length));
  return match?.groups === undefined
    ? null
    : {
        dev: BigInt(match.groups.dev as string),
        ino: BigInt(match.groups.ino as string),
      };
};

export const parseRemovalBinding = (
  candidate: string,
): { readonly identity: NodeIdentity; readonly original: string } | null => {
  if (!candidate.startsWith(REMOVAL_BINDING_PREFIX)) {
    return null;
  }
  const suffix = candidate.slice(REMOVAL_BINDING_PREFIX.length);
  const match = REMOVAL_BINDING.exec(suffix);
  if (match?.groups === undefined) {
    return null;
  }
  const original = Buffer.from(
    match.groups.encoded as string,
    'base64url',
  ).toString();
  if (Buffer.from(original).toString('base64url') !== match.groups.encoded) {
    return null;
  }
  return {
    identity: {
      dev: BigInt(match.groups.dev as string),
      ino: BigInt(match.groups.ino as string),
    },
    original,
  };
};

const inspectEntry = async (
  directory: PinnedDirectory,
  name: string,
  kind: 'directory' | 'file',
): Promise<NodeIdentity | null> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      directoryEntryPath(directory, name),
      constants.O_RDONLY +
        constants.O_NOFOLLOW +
        constants.O_NONBLOCK +
        (kind === 'directory' ? constants.O_DIRECTORY : 0),
    );
  } catch (error) {
    if (missing(error)) {
      return null;
    }
    throw error;
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (
      (kind === 'file' && !info.isFile()) ||
      (kind === 'directory' && !info.isDirectory())
    ) {
      throw new Error(`Removal target has changed kind: ${name}`);
    }
    return identityOf(info);
  } finally {
    await handle.close();
  }
};

export const findRemovalBinding = async (
  directory: PinnedDirectory,
  name: string,
): Promise<{
  readonly identity: NodeIdentity;
  readonly name: string;
} | null> => {
  const candidates = (await readdir(directoryEntryPath(directory, '.'))).filter(
    (entry) => entry.startsWith(bindingPrefix(name)),
  );
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length !== 1) {
    throw new Error(`Multiple removal bindings exist for ${name}`);
  }
  const candidate = candidates[0] as string;
  const identity = parseIdentity(name, candidate);
  if (identity === null) {
    throw new Error(`Removal binding is invalid for ${name}`);
  }
  return { identity, name: candidate };
};

export const resolveRemovalEntryName = async (
  directory: PinnedDirectory,
  name: string,
): Promise<string> => (await findRemovalBinding(directory, name))?.name ?? name;

export const openRemovalBindingDirectory = async (
  directory: PinnedDirectory,
  name: string,
): Promise<PinnedDirectory | null> => {
  const binding = await findRemovalBinding(directory, name);
  if (binding === null) {
    return null;
  }
  const opened = await openPinnedChild(directory, binding.name);
  if (!identitiesMatch(binding.identity, opened.identity)) {
    await opened.handle.close();
    throw new Error(`Removal directory binding changed: ${name}`);
  }
  return opened;
};

export const bindAndRemoveEntry = async ({
  afterBind,
  afterRemove,
  directory,
  expected,
  kind,
  name,
}: {
  readonly afterBind?: () => Promise<void>;
  readonly afterRemove?: () => Promise<void>;
  readonly directory: PinnedDirectory;
  readonly expected: NodeIdentity;
  readonly kind: 'directory' | 'file';
  readonly name: string;
}): Promise<void> => {
  const bindingName = removalBindingName(name, expected);
  const existingBinding = await findRemovalBinding(directory, name);
  const createdBinding = existingBinding === null;
  if (createdBinding) {
    renameDirectoryNoReplace(directory.handle.fd, name, bindingName);
    await afterBind?.();
  } else if ((await inspectEntry(directory, name, kind)) !== null) {
    throw new Error(`Removal target and binding both exist: ${name}`);
  }
  const bound = await inspectEntry(directory, bindingName, kind);
  if (!identitiesMatch(expected, bound)) {
    if (createdBinding) {
      try {
        renameDirectoryNoReplace(directory.handle.fd, bindingName, name);
      } catch {
        // Preserve both the public replacement and the mismatched bound entry.
      }
    }
    throw new Error(`Removal target changed before binding: ${name}`);
  }
  if (kind === 'file') {
    await unlink(directoryEntryPath(directory, bindingName));
  } else {
    await rmdir(directoryEntryPath(directory, bindingName));
  }
  await afterRemove?.();
  await syncPinnedDirectory(directory);
};

export const removalBindingIdentity = parseIdentity;
