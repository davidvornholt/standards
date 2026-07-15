import { afterEach, expect, it } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { openPinnedRoot } from './sync-directory-handles';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  replaceFixtureFile,
  temporaryRoot,
  writeFixture,
} from './sync-mutations-test-helpers';
import type { NodeIdentity } from './sync-node-identity';
import { validatedTransactionArtifacts } from './sync-transaction-artifact-set';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';

afterEach(cleanupFixtures);

it('validates every retained same-name artifact generation by exact identity', async () => {
  const rootPath = temporaryRoot();
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const directory = await openPinnedRoot(root);
  try {
    const retain = async (contents: string): Promise<NodeIdentity> => {
      writeFixture(rootPath, 'owned', contents);
      const info = statSync(join(rootPath, 'owned'), { bigint: true });
      const identity = { dev: info.dev, ino: info.ino };
      await bindAndRemoveEntry({
        directory,
        expected: identity,
        kind: 'file',
        name: 'owned',
      });
      return identity;
    };
    const identities = [await retain('first\n'), await retain('second\n')];
    const artifacts = await validatedTransactionArtifacts(
      directory,
      new Set(['owned']),
    );
    expect(
      artifacts
        .map(({ expected }) => `${expected?.dev}:${expected?.ino}`)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(
      identities
        .map(({ dev, ino }) => `${dev}:${ino}`)
        .sort((left, right) => left.localeCompare(right)),
    );
  } finally {
    await directory.handle.close();
  }
});

it('accepts an unbound intent only while its public source identity matches', async () => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'owned', 'owned\n');
  const info = statSync(join(rootPath, 'owned'), { bigint: true });
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const directory = await openPinnedRoot(root);
  try {
    await expect(
      bindAndRemoveEntry({
        beforeBind: () => Promise.reject(new Error('crash before bind')),
        directory,
        expected: { dev: info.dev, ino: info.ino },
        kind: 'file',
        name: 'owned',
      }),
    ).rejects.toThrow('crash before bind');
    expect(
      await validatedTransactionArtifacts(directory, new Set(['owned'])),
    ).toEqual([
      {
        expected: { dev: info.dev, ino: info.ino },
        name: 'owned',
      },
    ]);
    replaceFixtureFile(join(rootPath, 'owned'), 'actor\n');
    await expect(
      validatedTransactionArtifacts(directory, new Set(['owned'])),
    ).rejects.toThrow('intent is not resumable');
  } finally {
    await directory.handle.close();
  }
});
