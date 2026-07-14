import { afterEach, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { openPinnedRoot } from './sync-directory-handles';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  replaceFixtureDirectory,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
} from './sync-mutations-test-helpers';
import { createTransactionDirectory } from './sync-transaction-publication';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';
import { TRANSACTION_DIRECTORY } from './sync-transaction-types';

const fixture = join(import.meta.dir, 'sync-transaction-crash-fixture.ts');
const OWNER_PUBLICATION = /^\.standards-owner-publication-/u;
const TRANSACTION_PUBLICATION = /^\.standards-transaction-publication-/u;

afterEach(cleanupFixtures);

it('never replaces an empty final directory that wins publication', async () => {
  const rootPath = temporaryRoot();
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const rootDirectory = await openPinnedRoot(root);
  let actorIdentity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    await expect(
      createTransactionDirectory(
        rootDirectory,
        '00000000-0000-4000-8000-000000000000',
        {
          afterOwnerReservationFinalSync: () => {
            const actor = join(rootPath, TRANSACTION_DIRECTORY);
            mkdirSync(actor);
            const info = statSync(actor);
            actorIdentity = { dev: info.dev, ino: info.ino };
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow('Could not atomically publish reserved entry');
  } finally {
    await rootDirectory.handle.close();
  }

  const actor = statSync(join(rootPath, TRANSACTION_DIRECTORY));
  if (actorIdentity === undefined) {
    throw new Error('Actor directory was not created');
  }
  expect({ dev: actor.dev, ino: actor.ino }).toEqual(actorIdentity);
  expect(readdirSync(join(rootPath, TRANSACTION_DIRECTORY))).toEqual([]);
  expect(transactionArtifacts(rootPath)).toEqual([TRANSACTION_DIRECTORY]);
});

it('preserves a staged-directory replacement after inode binding', async () => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const crash = spawnSync(
    process.execPath,
    [fixture, rootPath, 'after-owner-reservation'],
    { stdio: 'pipe' },
  );
  expect(crash.signal).toBe('SIGKILL');
  const publication = transactionArtifacts(rootPath).find((entry) =>
    TRANSACTION_PUBLICATION.test(entry),
  );
  expect(publication).toBeDefined();
  const staged = join(rootPath, publication ?? 'missing');
  replaceFixtureDirectory(staged);
  const actor = statSync(staged);

  const root = await openRepositoryRoot(rootPath, 'consumer');
  await expect(recoverRepositoryTransactions(root)).rejects.toThrow(
    'Owner publication token does not match active inode',
  );

  const after = statSync(staged);
  expect({ dev: after.dev, ino: after.ino }).toEqual({
    dev: actor.dev,
    ino: actor.ino,
  });
  expect(readdirSync(staged)).toEqual([]);
  expect(transactionArtifacts(rootPath)).toEqual([
    expect.stringMatching(OWNER_PUBLICATION),
    expect.stringMatching(TRANSACTION_PUBLICATION),
    '.standards-transaction-reservation',
  ]);
});

it('retains an unbound staged directory across repeated recovery', async () => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const crash = spawnSync(
    process.execPath,
    [fixture, rootPath, 'after-transaction-publication-mkdir'],
    { stdio: 'pipe' },
  );
  expect(crash.signal).toBe('SIGKILL');
  const publication = transactionArtifacts(rootPath).find((entry) =>
    TRANSACTION_PUBLICATION.test(entry),
  );
  expect(publication).toBeDefined();
  const staged = join(rootPath, publication ?? 'missing');
  const before = statSync(staged);
  const root = await openRepositoryRoot(rootPath, 'consumer');

  await expect(recoverRepositoryTransactions(root)).rejects.toThrow(
    'Staged transaction publication is not inode-bound',
  );
  await expect(recoverRepositoryTransactions(root)).rejects.toThrow(
    'Staged transaction publication is not inode-bound',
  );

  const after = statSync(staged);
  expect({ dev: after.dev, ino: after.ino }).toEqual({
    dev: before.dev,
    ino: before.ino,
  });
  expect(transactionArtifacts(rootPath)).toEqual([
    expect.stringMatching(TRANSACTION_PUBLICATION),
    '.standards-transaction-reservation',
  ]);
});
