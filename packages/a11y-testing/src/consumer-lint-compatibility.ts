import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

type SyncLock = {
  readonly files: Readonly<Record<string, unknown>>;
};

export type TextFile = {
  readonly path: string;
  readonly source: string;
};

const directiveName = ['biome', 'ignore'].join('-');
const directivePattern = new RegExp(
  String.raw`^[\t ]*(?:(?://|#|/\*+|\*|<!--|\{[\t ]*/\*)[\t ]*)${directiveName}(?:-(?:all|start|end))?[\t ]+(?:assist|format|lint|syntax)(?:/[^\s:]+)*[\t ]*:`,
  'u',
);
const ignoredDirectoryPattern = /^(?<directory>[.\w-]+)\/$/u;

const isSyncLock = (value: unknown): value is SyncLock =>
  typeof value === 'object' &&
  value !== null &&
  'files' in value &&
  typeof value.files === 'object' &&
  value.files !== null &&
  !Array.isArray(value.files);

const toPosix = (path: string): string => path.split(sep).join('/');

export const parseIgnoredDirectoryNames = (
  ignoreFile: string,
): ReadonlySet<string> =>
  new Set([
    '.git',
    ...ignoreFile.split('\n').flatMap((line) => {
      const directory = ignoredDirectoryPattern.exec(line.trim())?.groups
        ?.directory;
      return directory === undefined ? [] : [directory];
    }),
  ]);

const walkSourceFiles = (
  directory: string,
  ignoredDirectoryNames: ReadonlySet<string>,
): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry: Dirent) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectoryNames.has(entry.name)
        ? []
        : walkSourceFiles(path, ignoredDirectoryNames);
    }
    return [path];
  });

const listLockedPackageFiles = (
  repositoryRoot: string,
  packageRoot: string,
): ReadonlyArray<string> | null => {
  const lockPath = join(repositoryRoot, 'sync-standards.lock');
  if (!existsSync(lockPath)) {
    return null;
  }
  const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (!isSyncLock(parsed)) {
    throw new Error('sync-standards.lock must contain a files object');
  }
  const packagePrefix = `${toPosix(relative(repositoryRoot, packageRoot))}/`;
  return Object.keys(parsed.files)
    .filter((path) => path.startsWith(packagePrefix))
    .map((path) => join(repositoryRoot, path));
};

export const listManagedTextFiles = (
  repositoryRoot: string,
  packageRoot: string,
): ReadonlyArray<TextFile> => {
  const lockedFiles = listLockedPackageFiles(repositoryRoot, packageRoot);
  const files =
    lockedFiles ??
    walkSourceFiles(
      packageRoot,
      parseIgnoredDirectoryNames(
        readFileSync(join(repositoryRoot, 'template/.gitignore'), 'utf8'),
      ),
    );
  return files.flatMap((path) => {
    const content = readFileSync(path);
    return content.includes(0)
      ? []
      : [
          {
            path: toPosix(relative(packageRoot, path)),
            source: content.toString('utf8'),
          },
        ];
  });
};

export const findBiomeSuppressions = (
  files: ReadonlyArray<TextFile>,
): ReadonlyArray<string> =>
  files.flatMap(({ path, source }) =>
    source
      .split('\n')
      .flatMap((line, index) =>
        directivePattern.test(line) ? [`${path}:${index + 1}`] : [],
      ),
  );
