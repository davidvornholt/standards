import { afterEach, describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openPinnedChild, openPinnedRoot } from './sync-directory-handles';
import { inspectRepositoryFiles } from './sync-file-inspection';
import { openRepositoryRoot } from './sync-filesystem';
import { applyRepositoryMutations } from './sync-mutations';
import {
  cleanupFixtures,
  readFixture,
  requiredState,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
} from './sync-mutations-test-helpers';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';
import {
  createCleanupReservation,
  createTransactionReservation,
} from './sync-transaction-reservation';
import {
  TRANSACTION_CLEANUP,
  TRANSACTION_DIRECTORY,
  TRANSACTION_OWNER,
} from './sync-transaction-types';

afterEach(cleanupFixtures);

const committedTransaction = async () => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const states = await inspectRepositoryFiles(root, ['sync-standards.lock']);
  await applyRepositoryMutations(
    {
      deletes: [],
      prunes: [],
      root,
      writes: [
        {
          before: requiredState(states, 'sync-standards.lock'),
          contents: Buffer.from('new lock\n'),
          mode: requiredState(states, 'sync-standards.lock').mode,
          rel: 'sync-standards.lock',
        },
      ],
    },
    { afterCommitted: () => Promise.reject(new Error('retain transaction')) },
  ).catch(() => undefined);
  return { root, rootPath };
};

describe('completed cleanup recovery', () => {
  it('preserves an unowned cleanup tombstone', async () => {
    const { root, rootPath } = await committedTransaction();
    const active = join(rootPath, TRANSACTION_DIRECTORY);
    unlinkSync(join(active, TRANSACTION_OWNER));
    renameSync(active, join(rootPath, TRANSACTION_CLEANUP));

    await expect(recoverRepositoryTransactions(root)).rejects.toThrow();

    expect(transactionArtifacts(rootPath)).toEqual([TRANSACTION_CLEANUP]);
  });

  it('preserves an empty cleanup tail with only a publication reservation', async () => {
    const { root, rootPath } = await committedTransaction();
    const active = join(rootPath, TRANSACTION_DIRECTORY);
    const owner = JSON.parse(
      readFileSync(join(active, TRANSACTION_OWNER), 'utf8'),
    ) as { readonly id: string };
    const cleanup = join(rootPath, TRANSACTION_CLEANUP);
    renameSync(active, cleanup);
    const rootDirectory = await openPinnedRoot(root);
    try {
      await createTransactionReservation(rootDirectory, owner.id);
    } finally {
      await rootDirectory.handle.close();
    }
    for (const artifact of readdirSync(cleanup)) {
      unlinkSync(join(cleanup, artifact));
    }

    await expect(recoverRepositoryTransactions(root)).rejects.toThrow();

    expect(readFixture(rootPath, 'sync-standards.lock')).toBe('new lock\n');
    expect([...transactionArtifacts(rootPath)].sort()).toEqual(
      ['.standards-transaction-reservation', TRANSACTION_CLEANUP].sort(),
    );
  });

  it('adopts an empty cleanup tail through its inode-bound cleanup token', async () => {
    const { root, rootPath } = await committedTransaction();
    const active = join(rootPath, TRANSACTION_DIRECTORY);
    const owner = JSON.parse(
      readFileSync(join(active, TRANSACTION_OWNER), 'utf8'),
    ) as { readonly id: string };
    const cleanupPath = join(rootPath, TRANSACTION_CLEANUP);
    renameSync(active, cleanupPath);
    const rootDirectory = await openPinnedRoot(root);
    const cleanup = await openPinnedChild(rootDirectory, TRANSACTION_CLEANUP);
    try {
      await createCleanupReservation({
        decision: 'committed',
        id: owner.id,
        reservedName: TRANSACTION_CLEANUP,
        root: rootDirectory,
        transaction: cleanup,
      });
    } finally {
      await cleanup.handle.close();
      await rootDirectory.handle.close();
    }
    for (const artifact of readdirSync(cleanupPath)) {
      unlinkSync(join(cleanupPath, artifact));
    }

    await recoverRepositoryTransactions(root);

    expect(readFixture(rootPath, 'sync-standards.lock')).toBe('new lock\n');
    expect(transactionArtifacts(rootPath)).toEqual([]);
  });
});
