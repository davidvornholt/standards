import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { openPinnedRoot } from './sync-directory-handles';
import { openRepositoryRoot } from './sync-filesystem';
import {
  linkDescriptorNoReplace,
  loadLinkAtFromProcess,
} from './sync-linux-link';
import { cleanupFixtures, temporaryRoot } from './sync-mutations-test-helpers';

afterEach(cleanupFixtures);

describe('Linux descriptor link resolution', () => {
  it('loads linkat from the current process libc', () => {
    const opened: Array<string> = [];
    const linkat = () => 0;
    expect(
      loadLinkAtFromProcess({
        loadLibrary: (path) => {
          opened.push(path);
          return { close: () => undefined, symbols: { linkat } };
        },
        readMaps: () =>
          '7f000000-7f100000 r-xp 00000000 08:01 1 /usr/lib/libc.so.6\n',
      }),
    ).toBe(linkat);
    expect(opened).toEqual(['/usr/lib/libc.so.6']);
  });
});

it('publishes the open inode without elevated capabilities', async () => {
  const rootPath = temporaryRoot();
  mkdirSync(join(rootPath, 'records'));
  const path = join(rootPath, 'records', 'temporary');
  writeFileSync(path, 'owned\n');
  const descriptor = await open(path, 'r');
  renameSync(path, join(rootPath, 'records', 'moved'));
  writeFileSync(path, 'replacement\n');
  const root = await openRepositoryRoot(join(rootPath, 'records'), 'records');
  const directory = await openPinnedRoot(root);
  try {
    linkDescriptorNoReplace(descriptor.fd, directory.handle.fd, 'published');
  } finally {
    await descriptor.close();
    await directory.handle.close();
  }
  expect(readFileSync(join(rootPath, 'records', 'published'), 'utf8')).toBe(
    'owned\n',
  );
});
