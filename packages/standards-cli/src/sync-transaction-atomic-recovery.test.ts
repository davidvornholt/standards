import { afterEach, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { openPinnedRoot } from './sync-directory-handles';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  readFixture,
  temporaryRoot,
} from './sync-mutations-test-helpers';
import { publishAtomicTransactionRecord } from './sync-transaction-atomic-record';
import { recoverAtomicPublicationTails } from './sync-transaction-atomic-recovery';
import { TRANSACTION_RESERVATION } from './sync-transaction-types';

const EXACT = `${TRANSACTION_RESERVATION}.11111111-1111-4111-8111-111111111111.tmp`;
const LOOKALIKE = `${TRANSACTION_RESERVATION}.11111111-1111-3111-8111-111111111111.tmp`;
const fixture = join(
  import.meta.dir,
  'sync-transaction-atomic-record-crash-fixture.ts',
);

afterEach(cleanupFixtures);

it('removes only exact reserved UUID-v4 publication tails', async () => {
  const rootPath = temporaryRoot();
  writeFileSync(join(rootPath, EXACT), 'partial');
  writeFileSync(join(rootPath, LOOKALIKE), 'unrelated');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const directory = await openPinnedRoot(root);
  try {
    await recoverAtomicPublicationTails(directory, TRANSACTION_RESERVATION);
  } finally {
    await directory.handle.close();
  }

  expect(existsSync(join(rootPath, EXACT))).toBe(false);
  expect(existsSync(join(rootPath, LOOKALIKE))).toBe(true);
});

it('reports exact reserved tails during read-only recovery', async () => {
  const rootPath = temporaryRoot();
  writeFileSync(join(rootPath, EXACT), 'partial');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const directory = await openPinnedRoot(root);
  try {
    await expect(
      recoverAtomicPublicationTails(directory, TRANSACTION_RESERVATION, false),
    ).rejects.toThrow('Pending atomic transaction record cleanup');
  } finally {
    await directory.handle.close();
  }

  expect(existsSync(join(rootPath, EXACT))).toBe(true);
});

it('preserves a temporary-name replacement installed after binding', async () => {
  const rootPath = temporaryRoot();
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const directory = await openPinnedRoot(root);
  let replacement = '';
  try {
    await publishAtomicTransactionRecord({
      afterTemporaryBind: (name) => {
        replacement = name;
        writeFileSync(join(rootPath, name), 'actor\n');
        return Promise.resolve();
      },
      contents: 'owned\n',
      directory,
      finalName: TRANSACTION_RESERVATION,
      maximumBytes: 1024,
    });
  } finally {
    await directory.handle.close();
  }

  expect(readFixture(rootPath, TRANSACTION_RESERVATION)).toBe('owned\n');
  expect(readFixture(rootPath, replacement)).toBe('actor\n');
});

it('recovers repeatedly after a publisher crash at the post-bind boundary', async () => {
  const rootPath = temporaryRoot();
  const finalName = TRANSACTION_RESERVATION;
  const crash = spawnSync(process.execPath, [fixture, rootPath, finalName], {
    stdio: 'pipe',
  });
  expect(crash.signal).toBe('SIGKILL');
  expect(
    readdirSync(rootPath).some((name) =>
      name.startsWith('.standards-removal-'),
    ),
  ).toBe(true);

  const root = await openRepositoryRoot(rootPath, 'consumer');
  const directory = await openPinnedRoot(root);
  try {
    await recoverAtomicPublicationTails(directory, finalName);
    await recoverAtomicPublicationTails(directory, finalName);
  } finally {
    await directory.handle.close();
  }

  expect(readFixture(rootPath, finalName)).toBe('owned\n');
  expect(
    readdirSync(rootPath).some((name) =>
      name.startsWith('.standards-removal-'),
    ),
  ).toBe(true);
});
