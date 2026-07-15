import type { BigIntStats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { isMissingFilesystemError } from './sync-filesystem-error';
import {
  assertFilesystemIdentityComponent,
  type NodeIdentity,
} from './sync-node-identity';
import { inspectRealDirectoryPath } from './sync-root-path';

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
