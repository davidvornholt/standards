import {
  lstat,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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

// A managed path is a file or a symlink. A symlink's identity is its target,
// never the content it resolves to: mirroring must reproduce the link itself,
// and following it would copy the whole target tree into every consumer.
export type ManagedEntry =
  | { readonly kind: 'file'; readonly absolutePath: string }
  | {
      readonly kind: 'symlink';
      readonly absolutePath: string;
      readonly target: string;
    }
  // Only ever observed when inspecting a destination a consumer replaced; the
  // upstream walk descends into directories instead of recording them.
  | { readonly kind: 'directory'; readonly absolutePath: string };

// Built rather than written as an escape so this source file stays plain ASCII
// and greppable. File digests remain plain content hashes, so existing consumer
// locks keep validating; the markers only need to be unreachable content for a
// canonical file, and no text file begins with a NUL byte.
const nul = String.fromCharCode(0);
const SYMLINK_DIGEST_PREFIX = `${nul}standards-symlink${nul}`;
const DIRECTORY_DIGEST = `${nul}standards-directory${nul}`;

export const inspectManagedPath = async (
  path: string,
): Promise<ManagedEntry | null> => {
  const info = await lstat(path).catch(() => null);
  if (info === null) {
    return null;
  }
  if (info.isSymbolicLink()) {
    return {
      kind: 'symlink',
      absolutePath: path,
      target: toPosix(await readlink(path)),
    };
  }
  if (info.isDirectory()) {
    return { kind: 'directory', absolutePath: path };
  }
  return { kind: 'file', absolutePath: path };
};

const walkManagedFiles = async (
  path: string,
  repositoryRoot: string,
  files: Map<string, ManagedEntry>,
): Promise<void> => {
  const entry = await inspectManagedPath(path);
  if (entry === null) {
    return;
  }
  if (entry.kind === 'directory') {
    const entries = await readdir(path);
    await Promise.all(
      entries
        .filter((name) => !IGNORED_DIRECTORIES.has(name))
        .map((name) =>
          walkManagedFiles(join(path, name), repositoryRoot, files),
        ),
    );
    return;
  }
  files.set(toPosix(relative(repositoryRoot, path)), entry);
};

export const listManagedFiles = async (
  repositoryRoot: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, ManagedEntry>> => {
  const files = new Map<string, ManagedEntry>();
  await Promise.all(
    paths.map((path) =>
      walkManagedFiles(join(repositoryRoot, path), repositoryRoot, files),
    ),
  );
  return files;
};

// What the lock hashes for an entry: file content, or the marker-prefixed link
// target. Retargeting a link therefore reads as drift the same way an edited
// file does.
export const managedEntryDigestInput = (
  entry: ManagedEntry,
): Promise<Buffer> => {
  if (entry.kind === 'symlink') {
    return Promise.resolve(
      Buffer.from(`${SYMLINK_DIGEST_PREFIX}${entry.target}`),
    );
  }
  if (entry.kind === 'directory') {
    return Promise.resolve(Buffer.from(DIRECTORY_DIGEST));
  }
  return readFile(entry.absolutePath);
};

// Plant one managed entry, replacing a file or a link that occupies the
// destination. Never recursive: a directory at the destination is unbounded
// consumer content, so removing it is the caller's decision to make explicitly
// once it has proven the path was engine-owned.
export const writeManagedEntry = async (
  dest: string,
  entry: ManagedEntry,
): Promise<void> => {
  if (entry.kind === 'directory') {
    throw new Error(`cannot mirror a directory as a managed path: ${dest}`);
  }
  const existing = await inspectManagedPath(dest);
  if (existing?.kind === 'directory') {
    throw new Error(
      `refusing to replace the directory ${dest} with a managed ${entry.kind}; move or delete it first`,
    );
  }
  // `symlink` refuses an existing path, and writing a file through a stale link
  // would clobber that link's target instead of replacing the managed path.
  if (
    existing !== null &&
    (entry.kind === 'symlink' || existing.kind === 'symlink')
  ) {
    await rm(dest, { force: true });
  }
  if (entry.kind === 'symlink') {
    await symlink(entry.target, dest);
    return;
  }
  await writeFile(dest, await readFile(entry.absolutePath));
};

export const findManagedFilesContainingBiomeDirectiveToken = async (
  files: ReadonlyMap<string, ManagedEntry>,
): Promise<ReadonlyArray<string>> => {
  const matches = await Promise.all(
    [...files].map(async ([path, entry]) =>
      entry.kind === 'file' &&
      (await readFile(entry.absolutePath)).includes(directiveToken)
        ? path
        : null,
    ),
  );
  return matches.filter((path): path is string => path !== null).sort();
};
