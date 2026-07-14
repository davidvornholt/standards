import { afterEach, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  readFixture,
  temporaryRoot,
  writeFixture,
} from './sync-mutations-test-helpers';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';
import {
  TRANSACTION_DIRECTORY,
  TRANSACTION_JOURNAL,
} from './sync-transaction-types';

const fixture = join(import.meta.dir, 'sync-transaction-crash-fixture.ts');

afterEach(cleanupFixtures);

const crashCommitted = (): string => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'managed/a.txt', 'old a\n');
  writeFixture(rootPath, 'managed/b.txt', 'old b\n');
  writeFixture(rootPath, 'managed/stale.txt', 'stale\n');
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const child = spawnSync(
    process.execPath,
    [fixture, rootPath, 'after-committed'],
    { stdio: 'pipe' },
  );
  if (child.signal !== 'SIGKILL') {
    throw new Error('Committed crash fixture did not stop');
  }
  return rootPath;
};

const recover = async (rootPath: string): Promise<void> => {
  const root = await openRepositoryRoot(rootPath, 'consumer');
  await recoverRepositoryTransactions(root);
};

it('preserves a same-content committed stage replacement and its WAL', async () => {
  const rootPath = crashCommitted();
  const stage = join(rootPath, TRANSACTION_DIRECTORY, 'new-1');
  rmSync(stage);
  writeFileSync(stage, 'new b\n');
  const actorInode = statSync(stage).ino;

  await expect(recover(rootPath)).rejects.toThrow(
    `Filesystem recovery retained ${TRANSACTION_DIRECTORY}`,
  );

  expect(readFixture(rootPath, `${TRANSACTION_DIRECTORY}/new-1`)).toBe(
    'new b\n',
  );
  expect(statSync(stage).ino).toBe(actorInode);
  expect(
    existsSync(join(rootPath, TRANSACTION_DIRECTORY, TRANSACTION_JOURNAL)),
  ).toBe(true);
});

it('preserves a same-content committed backup replacement and its WAL', async () => {
  const rootPath = crashCommitted();
  const journal = JSON.parse(
    readFixture(rootPath, `${TRANSACTION_DIRECTORY}/${TRANSACTION_JOURNAL}`),
  ) as {
    readonly operations: ReadonlyArray<{
      readonly backup: string;
      readonly before: { readonly mode: number | null };
      readonly rel: string;
    }>;
  };
  const operation = journal.operations.find(
    ({ rel }) => rel === 'managed/b.txt',
  );
  if (operation === undefined || operation.before.mode === null) {
    throw new Error('Missing committed backup fixture');
  }
  const backup = join(rootPath, TRANSACTION_DIRECTORY, operation.backup);
  rmSync(backup);
  writeFileSync(backup, 'old b\n', { mode: operation.before.mode });
  const actorInode = statSync(backup).ino;

  await expect(recover(rootPath)).rejects.toThrow(
    `Filesystem recovery retained ${TRANSACTION_DIRECTORY}`,
  );

  expect(
    readFixture(rootPath, `${TRANSACTION_DIRECTORY}/${operation.backup}`),
  ).toBe('old b\n');
  expect(statSync(backup).ino).toBe(actorInode);
  expect(
    existsSync(join(rootPath, TRANSACTION_DIRECTORY, TRANSACTION_JOURNAL)),
  ).toBe(true);
});
