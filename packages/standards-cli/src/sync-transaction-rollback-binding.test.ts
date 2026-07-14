import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
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
import {
  TRANSACTION_DIRECTORY,
  TRANSACTION_JOURNAL,
} from './sync-transaction-types';

const fixture = join(import.meta.dir, 'sync-transaction-crash-fixture.ts');

afterEach(cleanupFixtures);

const crashAtBinding = (phase: string, rel: string) => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'managed/a.txt', 'old a\n');
  writeFixture(rootPath, 'managed/b.txt', 'old b\n');
  writeFixture(rootPath, 'managed/stale.txt', 'stale\n');
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const crash = spawnSync(process.execPath, [fixture, rootPath, phase], {
    stdio: 'pipe',
  });
  if (crash.signal !== 'SIGKILL') {
    throw new Error(`Crash fixture did not stop at ${phase}`);
  }
  const journal = JSON.parse(
    readFixture(rootPath, `${TRANSACTION_DIRECTORY}/${TRANSACTION_JOURNAL}`),
  ) as {
    readonly operations: ReadonlyArray<{
      readonly backup: string;
      readonly before: { readonly mode: number | null };
      readonly desired: { readonly mode: number } | null;
      readonly rel: string;
    }>;
  };
  const operation = journal.operations.find(
    (candidate) => candidate.rel === rel,
  );
  if (operation === undefined) {
    throw new Error(`Missing journal operation for ${rel}`);
  }
  return {
    binding: join(
      rootPath,
      TRANSACTION_DIRECTORY,
      operation.backup.replace('old-', 'rollback-'),
    ),
    operation,
    rootPath,
  };
};

const recover = async (rootPath: string): Promise<void> => {
  const root = await openRepositoryRoot(rootPath, 'consumer');
  await recoverRepositoryTransactions(root);
};

describe('rollback binding identity', () => {
  for (const [phase, rel] of [
    ['rollback-remove-after-bind', 'managed/a.txt'],
    ['rollback-restore-after-bind', 'managed/stale.txt'],
  ] as const) {
    it(`converges repeatedly after ${phase}`, async () => {
      const { rootPath } = crashAtBinding(phase, rel);

      await recover(rootPath);
      await recover(rootPath);

      expect(readFixture(rootPath, 'managed/a.txt')).toBe('old a\n');
      expect(readFixture(rootPath, 'managed/b.txt')).toBe('old b\n');
      expect(readFixture(rootPath, 'managed/stale.txt')).toBe('stale\n');
      expect(readFixture(rootPath, 'sync-standards.lock')).toBe('old lock\n');
      expect(transactionArtifacts(rootPath)).toEqual([]);
    });
  }

  it('preserves a same-content replacement of a bound installed target', async () => {
    const { binding, operation, rootPath } = crashAtBinding(
      'rollback-remove-after-bind',
      'managed/a.txt',
    );
    if (operation.desired === null) {
      throw new Error('Missing desired target state');
    }
    replaceFixtureFile(binding, 'new a\n', operation.desired.mode);
    const actorInode = statSync(binding).ino;

    await expect(recover(rootPath)).rejects.toThrow(
      `Filesystem recovery retained ${TRANSACTION_DIRECTORY}`,
    );
    await expect(recover(rootPath)).rejects.toThrow(
      `Filesystem recovery retained ${TRANSACTION_DIRECTORY}`,
    );

    expect(readFixture(rootPath, binding.slice(rootPath.length + 1))).toBe(
      'new a\n',
    );
    expect(statSync(binding).ino).toBe(actorInode);
    expect(
      existsSync(join(rootPath, TRANSACTION_DIRECTORY, TRANSACTION_JOURNAL)),
    ).toBe(true);
  });

  it('preserves a same-content replacement of a bound prior backup', async () => {
    const { binding, operation, rootPath } = crashAtBinding(
      'rollback-restore-after-bind',
      'managed/stale.txt',
    );
    if (operation.before.mode === null) {
      throw new Error('Missing prior backup mode');
    }
    replaceFixtureFile(binding, 'stale\n', operation.before.mode);
    const actorInode = statSync(binding).ino;

    await expect(recover(rootPath)).rejects.toThrow(
      `Filesystem recovery retained ${TRANSACTION_DIRECTORY}`,
    );
    await expect(recover(rootPath)).rejects.toThrow(
      `Filesystem recovery retained ${TRANSACTION_DIRECTORY}`,
    );

    expect(readFixture(rootPath, binding.slice(rootPath.length + 1))).toBe(
      'stale\n',
    );
    expect(statSync(binding).ino).toBe(actorInode);
    expect(
      existsSync(join(rootPath, TRANSACTION_DIRECTORY, TRANSACTION_JOURNAL)),
    ).toBe(true);
  });
});
