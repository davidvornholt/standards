import { afterEach, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  readFixture,
  replaceFixtureFile,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
} from './sync-mutations-test-helpers';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';

const fixture = join(import.meta.dir, 'sync-transaction-crash-fixture.ts');
const OWNER_PUBLICATION = /^\.standards-owner-publication-/u;
const OWNER_TAIL = /^OWNER\..+\.tmp$/u;

afterEach(cleanupFixtures);

it('preserves a replacement installed during an owner write crash', async () => {
  const root = temporaryRoot();
  writeFixture(root, 'managed/a.txt', 'old a\n');
  writeFixture(root, 'managed/b.txt', 'old b\n');
  writeFixture(root, 'managed/stale.txt', 'stale\n');
  writeFixture(root, 'sync-standards.lock', 'old lock\n');
  const crash = spawnSync(
    process.execPath,
    [fixture, root, 'during-owner-write'],
    { stdio: 'pipe' },
  );
  expect(crash.signal).toBe('SIGKILL');
  const transaction = join(root, '.standards-transaction');
  const tail = readdirSync(transaction).find((entry) => OWNER_TAIL.test(entry));
  expect(tail).toBeDefined();
  replaceFixtureFile(
    join(transaction, tail ?? 'missing'),
    'actor replacement\n',
  );

  const repository = await openRepositoryRoot(root, 'consumer');
  await expect(recoverRepositoryTransactions(repository)).rejects.toThrow(
    'Atomic transaction record tail changed after binding',
  );

  expect(readFixture(root, `.standards-transaction/${tail}`)).toBe(
    'actor replacement\n',
  );
  expect(transactionArtifacts(root)).toEqual([
    expect.stringMatching(OWNER_PUBLICATION),
    '.standards-transaction',
  ]);
});
