import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

// Never mirrored, even under a managed directory path: build output, VCS
// metadata, and installed dependencies would otherwise pollute the lock when
// syncing from a working tree that has them.
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  '.next',
]);

const directiveToken = Buffer.from(['biome', 'ignore'].join('-'));

const toPosix = (path: string): string => path.split(sep).join('/');

const walkManagedFiles = async (
  path: string,
  repositoryRoot: string,
  files: Map<string, string>,
): Promise<void> => {
  const info = await stat(path).catch(() => null);
  if (info === null) {
    return;
  }
  if (info.isDirectory()) {
    const entries = await readdir(path);
    await Promise.all(
      entries
        .filter((entry) => !IGNORED_DIRECTORIES.has(entry))
        .map((entry) =>
          walkManagedFiles(join(path, entry), repositoryRoot, files),
        ),
    );
    return;
  }
  files.set(toPosix(relative(repositoryRoot, path)), path);
};

export const listManagedFiles = async (
  repositoryRoot: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, string>> => {
  const files = new Map<string, string>();
  await Promise.all(
    paths.map((path) =>
      walkManagedFiles(join(repositoryRoot, path), repositoryRoot, files),
    ),
  );
  return files;
};

export const findManagedFilesContainingBiomeDirectiveToken = async (
  files: ReadonlyMap<string, string>,
): Promise<ReadonlyArray<string>> => {
  const matches = await Promise.all(
    [...files].map(async ([path, absolutePath]) =>
      (await readFile(absolutePath)).includes(directiveToken) ? path : null,
    ),
  );
  return matches.filter((path): path is string => path !== null).sort();
};
