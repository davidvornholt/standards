import { describe, expect, it } from 'bun:test';
import {
  loadedLibcPaths,
  loadRenameAt2FromProcess,
  type RenameLibraryLoader,
} from './sync-linux-rename';

const renameAt2 = (): number => 0;
const library = {
  close: () => undefined,
  symbols: { renameat2: renameAt2 },
};

describe('current-process libc resolution', () => {
  it('loads renameat2 from the mapped glibc object', () => {
    const opened: Array<string> = [];
    const loaded = loadRenameAt2FromProcess({
      loadLibrary: (path) => {
        opened.push(path);
        return library;
      },
      readMaps: () =>
        '7f000000-7f100000 r-xp 00000000 08:01 1 /usr/lib/x86_64-linux-gnu/libc.so.6\n',
    });

    expect(loaded).toBe(renameAt2);
    expect(opened).toEqual(['/usr/lib/x86_64-linux-gnu/libc.so.6']);
  });

  it('loads renameat2 from the mapped musl runtime', () => {
    const opened: Array<string> = [];
    loadRenameAt2FromProcess({
      loadLibrary: (path) => {
        opened.push(path);
        return library;
      },
      readMaps: () =>
        '7f000000-7f100000 r-xp 00000000 08:01 1 /lib/ld-musl-x86_64.so.1\n',
    });

    expect(opened).toEqual(['/lib/ld-musl-x86_64.so.1']);
  });

  it('tries each loaded libc object and fails closed when none exports renameat2', () => {
    const opened: Array<string> = [];
    const loadLibrary: RenameLibraryLoader = (path) => {
      opened.push(path);
      throw new Error(`missing from ${path}`);
    };

    expect(() =>
      loadRenameAt2FromProcess({
        loadLibrary,
        readMaps: () =>
          [
            '7f000000-7f100000 r-xp 00000000 08:01 1 /lib/libc.musl-aarch64.so.1',
            '7f200000-7f300000 r-xp 00000000 08:01 2 /lib/libc.so.6',
          ].join('\n'),
      }),
    ).toThrow('The loaded Linux libc does not expose renameat2');
    expect(opened).toEqual(['/lib/libc.musl-aarch64.so.1', '/lib/libc.so.6']);
  });

  it('ignores unrelated mapped objects and deleted libc paths', () => {
    expect(
      loadedLibcPaths(
        [
          '7f000000-7f100000 r-xp 00000000 08:01 1 /usr/lib/libssl.so.3',
          '7f200000-7f300000 r-xp 00000000 08:01 2 /lib/libc.so.6 (deleted)',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});
