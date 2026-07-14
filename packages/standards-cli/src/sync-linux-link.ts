// biome-ignore lint/correctness/noUnresolvedImports: Bun provides bun:ffi as a built-in module.
import { dlopen } from 'bun:ffi';
import { readFileSync } from 'node:fs';
import { loadedLibcPaths } from './sync-linux-rename';

const AT_FDCWD = -100;
const AT_SYMLINK_FOLLOW = 0x4_00;
const PROCESS_MAPS = '/proc/self/maps';
const LINK_AT_SYMBOL = {
  linkat: {
    args: ['i32', 'ptr', 'i32', 'ptr', 'i32'],
    returns: 'i32',
  },
} as const;

// biome-ignore lint/complexity/useMaxParams: the signature mirrors the fixed libc linkat ABI
type LinkAt = (
  oldDirectory: number,
  oldName: Buffer,
  newDirectory: number,
  newName: Buffer,
  flags: number,
) => number;

type LinkLibrary = {
  readonly close: () => void;
  readonly symbols: { readonly linkat: LinkAt };
};

export type LinkLibraryLoader = (path: string) => LinkLibrary;

const libraries: Array<LinkLibrary> = [];

export const loadLinkAtFromProcess = ({
  loadLibrary,
  readMaps,
}: {
  readonly loadLibrary: LinkLibraryLoader;
  readonly readMaps: () => string;
}): LinkAt => {
  const failures: Array<unknown> = [];
  for (const path of loadedLibcPaths(readMaps())) {
    try {
      const library = loadLibrary(path);
      libraries.push(library);
      return library.symbols.linkat;
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(
    failures,
    'The loaded Linux libc does not expose linkat',
  );
};

let loadedLinkAt: LinkAt | undefined;

const linkAt = (): LinkAt => {
  try {
    loadedLinkAt ??= loadLinkAtFromProcess({
      loadLibrary: (path) => dlopen(path, LINK_AT_SYMBOL),
      readMaps: () => readFileSync(PROCESS_MAPS, 'utf8'),
    });
    return loadedLinkAt;
  } catch (error) {
    throw new Error(
      'Safe transaction record publication requires Linux linkat support',
      { cause: error },
    );
  }
};

const cString = (name: string): Buffer => {
  if (name.includes('\0')) {
    throw new Error('Filesystem entry name contains a null byte');
  }
  return Buffer.from(`${name}\0`);
};

export const linkDescriptorNoReplace = (
  descriptor: number,
  directory: number,
  name: string,
): void => {
  if (
    linkAt()(
      AT_FDCWD,
      cString(`/proc/self/fd/${descriptor}`),
      directory,
      cString(name),
      AT_SYMLINK_FOLLOW,
    ) !== 0
  ) {
    throw new Error(`Could not atomically publish transaction record: ${name}`);
  }
};
