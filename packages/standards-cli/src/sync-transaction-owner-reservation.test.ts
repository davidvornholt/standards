import { afterEach, expect, it } from 'bun:test';
import { openPinnedRoot } from './sync-directory-handles';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  temporaryRoot,
  writeFixture,
} from './sync-mutations-test-helpers';
import { MAX_FILESYSTEM_IDENTITY } from './sync-node-identity';
import { findOwnerPublicationTokenEntry } from './sync-transaction-owner-reservation';

afterEach(cleanupFixtures);

const ID = '00000000-0000-4000-8000-000000000000';
const PREFIX = `.standards-owner-publication-${ID}`;
const MAX = MAX_FILESYSTEM_IDENTITY.toString();
const OVERFLOW = (MAX_FILESYSTEM_IDENTITY + 1n).toString();

const readToken = async (suffix: string) => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, `${PREFIX}-${suffix}`, '');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const directory = await openPinnedRoot(root);
  try {
    return await findOwnerPublicationTokenEntry(directory);
  } finally {
    await directory.handle.close();
  }
};

it('bounds owner-publication token identities to uint64', async () => {
  expect((await readToken(`${MAX}-${MAX}-${MAX}-${MAX}`))?.transaction).toEqual(
    {
      dev: MAX_FILESYSTEM_IDENTITY,
      ino: MAX_FILESYSTEM_IDENTITY,
    },
  );
  await expect(readToken(`${OVERFLOW}-1`)).rejects.toThrow('uint64');
  await expect(readToken(`1-1-${OVERFLOW}-1`)).rejects.toThrow('uint64');
});
