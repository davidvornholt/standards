import { type BigIntStats, constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { isMissingFilesystemError } from './sync-filesystem-error';
import { assertFilesystemIdentityComponent } from './sync-node-identity';
import { inspectRealDirectoryPath } from './sync-root-path';
export type NodeIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
};

export type RepositoryRoot = {
  readonly identity: NodeIdentity;
  readonly label: string;
  readonly path: string;
};

export type FileState = {
  readonly contents: Buffer | null;
  readonly identity: NodeIdentity | null;
  readonly mode: number | null;
};

export type PreparedDirectory = {
  readonly identity: NodeIdentity;
  readonly rel: string;
};

export const fileStatesMatch = (left: FileState, right: FileState): boolean =>
  identitiesMatch(left.identity, right.identity) &&
  left.mode === right.mode &&
  (left.contents === right.contents ||
    (left.contents !== null &&
      right.contents !== null &&
      left.contents.equals(right.contents)));

const FILE_TYPE_MODE_BASE = 0o1000;

export const identityOf = (info: {
  readonly dev: bigint;
  readonly ino: bigint;
}): NodeIdentity => ({
  dev: assertFilesystemIdentityComponent(info.dev, 'filesystem device'),
  ino: assertFilesystemIdentityComponent(info.ino, 'filesystem inode'),
});

export const identitiesMatch = (
  left: NodeIdentity | null,
  right: NodeIdentity | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.dev === right.dev &&
    left.ino === right.ino);

export const assertRepositoryRelativePath = (
  path: string,
  label: string,
): void => {
  const normalized = normalize(path);
  if (
    path.length === 0 ||
    path === '.' ||
    isAbsolute(path) ||
    path.includes('\\') ||
    normalized !== path ||
    path.split('/').includes('..')
  ) {
    throw new Error(
      `${label} must be a normalized repository-relative path: ${path}`,
    );
  }
};

const assertInside = (root: RepositoryRoot, path: string): void => {
  const rel = relative(root.path, path);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`${root.label} path escapes its root: ${path}`);
  }
};

export const openRepositoryRoot = async (
  path: string,
  label: string,
): Promise<RepositoryRoot> => {
  const { canonical, info } = await inspectRealDirectoryPath(path, label);
  return { identity: identityOf(info), label, path: canonical };
};

export const inspectRepositoryNode = (
  root: RepositoryRoot,
  rel: string,
): Promise<{ readonly path: string; readonly info: BigIntStats | null }> => {
  assertRepositoryRelativePath(rel, `${root.label} path`);
  const parts = rel.split('/');
  const inspectPart = async (
    index: number,
    parent: string,
  ): Promise<{ readonly path: string; readonly info: BigIntStats | null }> => {
    const current = join(parent, parts[index] ?? '');
    assertInside(root, current);
    let info: BigIntStats;
    try {
      info = await lstat(current, { bigint: true });
    } catch (error) {
      if (isMissingFilesystemError(error)) {
        return { path: join(root.path, ...parts), info: null };
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`${root.label} path must not be a symbolic link: ${rel}`);
    }
    const canonical = await realpath(current);
    assertInside(root, canonical);
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(
        `${root.label} parent component must be a directory: ${parts.slice(0, index + 1).join('/')}`,
      );
    }
    if (index === parts.length - 1) {
      return { path: current, info };
    }
    return inspectPart(index + 1, current);
  };
  return inspectPart(0, root.path);
};

export const inspectRepositoryFile = async (
  root: RepositoryRoot,
  rel: string,
): Promise<FileState> => {
  const node = await inspectRepositoryNode(root, rel);
  if (node.info === null) {
    return { contents: null, identity: null, mode: null };
  }
  if (!node.info.isFile()) {
    throw new Error(`${root.label} path must be a regular file: ${rel}`);
  }
  const handle = await open(
    node.path,
    constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !(
        opened.isFile() &&
        identitiesMatch(identityOf(node.info), identityOf(opened))
      )
    ) {
      throw new Error(`${root.label} file changed during inspection: ${rel}`);
    }
    return {
      contents: await handle.readFile(),
      identity: identityOf(opened),
      mode: Number(opened.mode) % FILE_TYPE_MODE_BASE,
    };
  } finally {
    await handle.close();
  }
};

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

export const inspectRepositoryDirectories = async (
  root: RepositoryRoot,
  rels: ReadonlyArray<string>,
): Promise<ReadonlyArray<PreparedDirectory>> =>
  Promise.all(
    [...new Set(rels)].map(async (rel) => {
      const node = await inspectRepositoryNode(root, rel);
      if (node.info === null || !node.info.isDirectory()) {
        throw new Error(`${root.label} path must be a directory: ${rel}`);
      }
      return { identity: identityOf(node.info), rel };
    }),
  );
