import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type FileState,
  identitiesMatch,
  inspectRepositoryFile,
  inspectRepositoryNode,
  type PreparedDirectory,
  type RepositoryRoot,
} from './sync-filesystem';

export type PreparedWrite = {
  readonly before: FileState;
  readonly contents: Buffer;
  readonly mode: number;
  readonly rel: string;
};

export type PreparedDelete = {
  readonly before: FileState;
  readonly rel: string;
};

type MutationPlan = {
  readonly deletes: ReadonlyArray<PreparedDelete>;
  readonly prunes: ReadonlyArray<PreparedDirectory>;
  readonly root: RepositoryRoot;
  readonly writes: ReadonlyArray<PreparedWrite>;
};

const identityOf = (info: { readonly dev: number; readonly ino: number }) => ({
  dev: info.dev,
  ino: info.ino,
});

const fileStatesMatch = (left: FileState, right: FileState): boolean =>
  identitiesMatch(left.identity, right.identity) &&
  (left.contents === right.contents ||
    (left.contents !== null &&
      right.contents !== null &&
      left.contents.equals(right.contents)));

const assertFileUnchanged = async (
  root: RepositoryRoot,
  rel: string,
  before: FileState,
): Promise<void> => {
  const current = await inspectRepositoryFile(root, rel);
  if (!fileStatesMatch(before, current)) {
    throw new Error(`${root.label} file changed after preflight: ${rel}`);
  }
};

const assertDirectoryUnchanged = async (
  root: RepositoryRoot,
  directory: PreparedDirectory,
): Promise<void> => {
  const node = await inspectRepositoryNode(root, directory.rel);
  if (
    node.info === null ||
    !node.info.isDirectory() ||
    !identitiesMatch(directory.identity, identityOf(node.info))
  ) {
    throw new Error(
      `${root.label} directory changed after preflight: ${directory.rel}`,
    );
  }
};

const ensureParents = async (
  root: RepositoryRoot,
  rel: string,
): Promise<void> => {
  const parts = dirname(rel)
    .split('/')
    .filter((part) => part !== '.');
  const ensureParent = async (length: number): Promise<void> => {
    if (length > parts.length) {
      return;
    }
    const parentRel = parts.slice(0, length).join('/');
    const node = await inspectRepositoryNode(root, parentRel);
    if (node.info === null) {
      await mkdir(join(root.path, parentRel));
      const created = await inspectRepositoryNode(root, parentRel);
      if (created.info === null || !created.info.isDirectory()) {
        throw new Error(
          `${root.label} could not create a real directory: ${parentRel}`,
        );
      }
    } else if (!node.info.isDirectory()) {
      throw new Error(
        `${root.label} parent component must be a directory: ${parentRel}`,
      );
    }
    await ensureParent(length + 1);
  };
  await ensureParent(1);
};

const writePreparedFile = async (
  root: RepositoryRoot,
  write: PreparedWrite,
): Promise<void> => {
  await assertFileUnchanged(root, write.rel, write.before);
  await ensureParents(root, write.rel);
  await assertFileUnchanged(root, write.rel, write.before);
  const target = join(root.path, write.rel);
  const temporary = join(dirname(target), `.standards-${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_CREAT +
      constants.O_EXCL +
      constants.O_WRONLY +
      constants.O_NOFOLLOW,
    write.mode,
  );
  try {
    await handle.writeFile(write.contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await assertFileUnchanged(root, write.rel, write.before);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

export const applyRepositoryMutations = async ({
  deletes,
  prunes,
  root,
  writes,
}: MutationPlan): Promise<void> => {
  await Promise.all([
    ...writes.map((write) =>
      assertFileUnchanged(root, write.rel, write.before),
    ),
    ...deletes.map((deletion) =>
      assertFileUnchanged(root, deletion.rel, deletion.before),
    ),
    ...prunes.map((directory) => assertDirectoryUnchanged(root, directory)),
  ]);

  const applyWrite = async (index: number): Promise<void> => {
    const write = writes[index];
    if (write === undefined) {
      return;
    }
    await writePreparedFile(root, write);
    await applyWrite(index + 1);
  };
  const applyDelete = async (index: number): Promise<void> => {
    const deletion = deletes[index];
    if (deletion === undefined) {
      return;
    }
    await assertFileUnchanged(root, deletion.rel, deletion.before);
    await unlink(join(root.path, deletion.rel));
    await applyDelete(index + 1);
  };
  const sortedPrunes = [...prunes].sort(
    (left, right) => right.rel.length - left.rel.length,
  );
  const applyPrune = async (index: number): Promise<void> => {
    const directory = sortedPrunes[index];
    if (directory === undefined) {
      return;
    }
    await assertDirectoryUnchanged(root, directory);
    await rmdir(join(root.path, directory.rel)).catch((error: unknown) => {
      const { code } = error as { readonly code?: unknown };
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
        throw error;
      }
    });
    await applyPrune(index + 1);
  };
  await applyWrite(0);
  await applyDelete(0);
  await applyPrune(0);
};
