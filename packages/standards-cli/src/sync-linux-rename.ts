// biome-ignore lint/correctness/noUnresolvedImports: Bun 1.3.14 provides bun:ffi, but Biome 2.5.3 does not resolve that built-in module.
import { dlopen } from 'bun:ffi';

const RENAME_NOREPLACE = 1;
const libcLibraries: Array<{ readonly close: () => void }> = [];

const openRenameAt2 = () => {
  try {
    const libc = dlopen('libc.so.6', {
      renameat2: {
        args: ['i32', 'ptr', 'i32', 'ptr', 'u32'],
        returns: 'i32',
      },
    });
    libcLibraries.push(libc);
    return libc.symbols.renameat2;
  } catch (error) {
    throw new Error(
      'Safe standards filesystem mutations require Linux renameat2 support',
      { cause: error },
    );
  }
};

let loadedRenameAt2: ReturnType<typeof openRenameAt2> | undefined;

const loadRenameAt2 = (): ReturnType<typeof openRenameAt2> => {
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
