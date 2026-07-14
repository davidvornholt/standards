// biome-ignore lint/correctness/noUnresolvedImports: Bun 1.3.14 provides bun:ffi, but Biome 2.5.3 does not resolve that built-in module.
import { dlopen } from 'bun:ffi';
import { readFileSync } from 'node:fs';

const RENAME_NOREPLACE = 1;
const PROCESS_MAPS = '/proc/self/maps';
const LIBC_BASENAME =
  /^(?:libc\.so(?:\.\d+)*|libc\.musl-[^/]+\.so\.1|ld-musl-[^/]+\.so\.1)$/u;
const RENAME_AT_2_SYMBOL = {
  renameat2: {
    args: ['i32', 'ptr', 'i32', 'ptr', 'u32'],
    returns: 'i32',
  },
} as const;

type RenameAt2Arguments = [number, Buffer, number, Buffer, number];
type RenameAt2 = (...args: RenameAt2Arguments) => number;

type RenameLibrary = {
  readonly close: () => void;
  readonly symbols: { readonly renameat2: RenameAt2 };
};

export type RenameLibraryLoader = (path: string) => RenameLibrary;

const libcLibraries: Array<RenameLibrary> = [];

export const loadedLibcPaths = (maps: string): ReadonlyArray<string> => {
  const paths = new Set<string>();
  for (const line of maps.split('\n')) {
    const path = line.slice(line.indexOf('/'));
    if (path.length > 0 && !path.includes(' ')) {
      const basename = path.slice(path.lastIndexOf('/') + 1);
      if (LIBC_BASENAME.test(basename)) {
        paths.add(path);
      }
    }
  }
  return [...paths];
};

export const loadRenameAt2FromProcess = ({
  loadLibrary,
  readMaps,
}: {
  readonly loadLibrary: RenameLibraryLoader;
  readonly readMaps: () => string;
}): RenameAt2 => {
  const paths = loadedLibcPaths(readMaps());
  if (paths.length === 0) {
    throw new Error('Could not identify the loaded Linux libc');
  }
  const failures: Array<unknown> = [];
  for (const path of paths) {
    try {
      const library = loadLibrary(path);
      libcLibraries.push(library);
      return library.symbols.renameat2;
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(
    failures,
    'The loaded Linux libc does not expose renameat2',
  );
};

const openRenameAt2 = (): RenameAt2 => {
  try {
    return loadRenameAt2FromProcess({
      loadLibrary: (path) => dlopen(path, RENAME_AT_2_SYMBOL),
      readMaps: () => readFileSync(PROCESS_MAPS, 'utf8'),
    });
  } catch (error) {
    throw new Error(
      'Safe standards filesystem mutations require Linux renameat2 support',
      { cause: error },
    );
  }
};

let loadedRenameAt2: RenameAt2 | undefined;

const loadRenameAt2 = (): RenameAt2 => {
  loadedRenameAt2 ??= openRenameAt2();
  return loadedRenameAt2;
};

const cString = (name: string): Buffer => {
  if (name.includes('\0')) {
    throw new Error('Filesystem entry name contains a null byte');
  }
  return Buffer.from(`${name}\0`);
};

export const assertNoReplaceRenameAvailable = (): void => {
  loadRenameAt2();
};

export const renameDirectoryNoReplace = (
  directory: number,
  oldName: string,
  newName: string,
): void => {
  const result = loadRenameAt2()(
    directory,
    cString(oldName),
    directory,
    cString(newName),
    RENAME_NOREPLACE,
  );
  if (result !== 0) {
    throw new Error(
      `Could not atomically publish reserved entry ${oldName} as ${newName}`,
    );
  }
};
