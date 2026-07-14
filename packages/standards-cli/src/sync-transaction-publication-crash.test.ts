import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { openPinnedRoot, syncPinnedDirectory } from './sync-directory-handles';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  readFixture,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
} from './sync-mutations-test-helpers';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';
import { createTransactionReservation } from './sync-transaction-reservation';

const fixture = join(import.meta.dir, 'sync-transaction-crash-fixture.ts');
const OWNER_PUBLICATION = /^\.standards-owner-publication-/u;

afterEach(cleanupFixtures);

const setup = (): string => {
  const root = temporaryRoot();
  writeFixture(root, 'managed/a.txt', 'old a\n');
  writeFixture(root, 'managed/b.txt', 'old b\n');
  writeFixture(root, 'managed/stale.txt', 'stale\n');
  writeFixture(root, 'sync-standards.lock', 'old lock\n');
  return root;
};

const crashAt = (root: string, phase: string): NodeJS.Signals | null =>
  spawnSync(process.execPath, [fixture, root, phase], { stdio: 'pipe' }).signal;

const recover = async (rootPath: string): Promise<void> => {
  const root = await openRepositoryRoot(rootPath, 'consumer');
  await recoverRepositoryTransactions(root);
};

describe('atomic transaction ownership publication', () => {
  for (const phase of [
    'after-reservation-final-sync',
    'after-owner-final-sync',
  ]) {
    it(`adopts a same-inode publication tail at ${phase}`, async () => {
      const root = setup();
      expect(crashAt(root, phase)).toBe('SIGKILL');

      await recover(root);

      expect(readFixture(root, 'sync-standards.lock')).toBe('old lock\n');
      expect(transactionArtifacts(root)).toEqual([]);
    });
  }

  it('cleans a partial reservation publication across repeated recovery', async () => {
    const root = setup();
    expect(crashAt(root, 'during-reservation-write')).toBe('SIGKILL');

    await recover(root);
    await recover(root);

    expect(readFixture(root, 'sync-standards.lock')).toBe('old lock\n');
    expect(transactionArtifacts(root)).toEqual([]);
  });

  it('cleans a partial owner publication across repeated recovery', async () => {
    const root = setup();
    expect(crashAt(root, 'during-owner-write')).toBe('SIGKILL');

    await recover(root);
    await recover(root);

    expect(transactionArtifacts(root)).toEqual([]);
    expect(readFixture(root, 'sync-standards.lock')).toBe('old lock\n');
  });

  it('cleans an inode-bound owner publication token repeatedly', async () => {
    const root = setup();
    expect(crashAt(root, 'after-owner-reservation')).toBe('SIGKILL');

    await recover(root);
    await recover(root);

    expect(transactionArtifacts(root)).toEqual([]);
    expect(readFixture(root, 'sync-standards.lock')).toBe('old lock\n');
  });

  it('cleans an owner publication token after its active inode is gone', async () => {
    const root = setup();
    expect(crashAt(root, 'after-owner-reservation')).toBe('SIGKILL');
    rmdirSync(join(root, '.standards-transaction'));

    await recover(root);
    await recover(root);

    expect(transactionArtifacts(root)).toEqual([]);
  });

  it('recovers an active directory after its inode binding hook', async () => {
    const root = setup();
    expect(crashAt(root, 'after-transaction-mkdir')).toBe('SIGKILL');

    await recover(root);

    expect(readFixture(root, 'sync-standards.lock')).toBe('old lock\n');
    expect(transactionArtifacts(root)).toEqual([]);
  });

  it('preserves an empty active-directory replacement after publication mkdir', async () => {
    const root = setup();
    expect(crashAt(root, 'after-transaction-mkdir')).toBe('SIGKILL');
    const transaction = join(root, '.standards-transaction');
    rmdirSync(transaction);
    mkdirSync(transaction);

    await expect(recover(root)).rejects.toThrow(
      'Owner publication token does not match active inode',
    );

    expect(readdirSync(transaction)).toEqual([]);
    expect([...transactionArtifacts(root)].sort()).toEqual([
      expect.stringMatching(OWNER_PUBLICATION),
      '.standards-transaction',
      '.standards-transaction-reservation',
    ]);
  });
});

describe('pre-binding transaction state', () => {
  it('preserves an active directory created before inode binding', async () => {
    const rootPath = setup();
    const root = await openRepositoryRoot(rootPath, 'consumer');
    const rootDirectory = await openPinnedRoot(root);
    try {
      await createTransactionReservation(
        rootDirectory,
        '00000000-0000-4000-8000-000000000000',
      );
      mkdirSync(join(rootPath, '.standards-transaction'));
      await syncPinnedDirectory(rootDirectory);
    } finally {
      await rootDirectory.handle.close();
    }

    await expect(recover(rootPath)).rejects.toThrow(
      'Reserved transaction has no inode-bound owner',
    );

    expect(readdirSync(join(rootPath, '.standards-transaction'))).toEqual([]);
    expect([...transactionArtifacts(rootPath)].sort()).toEqual(
      ['.standards-transaction', '.standards-transaction-reservation'].sort(),
    );
  });
});
