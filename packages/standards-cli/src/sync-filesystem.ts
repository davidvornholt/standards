import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export type NodeIdentity = {
  readonly dev: number;
  readonly ino: number;
};

export type RepositoryRoot = {
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

const FILE_TYPE_MODE_BASE = 0o1000;

const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

const identityOf = (info: Stats): NodeIdentity => ({
  dev: info.dev,
  ino: info.ino,
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
  const lexical = resolve(path);
  const lexicalInfo = await lstat(lexical);
  if (lexicalInfo.isSymbolicLink() || !lexicalInfo.isDirectory()) {
    throw new Error(`${label} root must be a real directory: ${lexical}`);
  }
  const canonical = await realpath(lexical);
  return { label, path: canonical };
};

export const inspectRepositoryNode = (
  root: RepositoryRoot,
  rel: string,
): Promise<{ readonly path: string; readonly info: Stats | null }> => {
  assertRepositoryRelativePath(rel, `${root.label} path`);
  const parts = rel.split('/');
  const inspectPart = async (
    index: number,
    parent: string,
  ): Promise<{ readonly path: string; readonly info: Stats | null }> => {
    const current = join(parent, parts[index] ?? '');
    assertInside(root, current);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (missing(error)) {
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
    constants.O_RDONLY + constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
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
      mode: opened.mode % FILE_TYPE_MODE_BASE,
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
