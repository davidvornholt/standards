import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  readFixture,
  replaceFixtureDirectory,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
} from './sync-mutations-test-helpers';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';

const fixture = join(import.meta.dir, 'sync-transaction-crash-fixture.ts');
const PARENT_BINDING = /^\.standards-parent-binding-/u;

afterEach(cleanupFixtures);

const setup = (): string => {
  const root = temporaryRoot();
  writeFixture(root, 'managed/a.txt', 'old a\n');
  writeFixture(root, 'managed/b.txt', 'old b\n');
  writeFixture(root, 'managed/stale.txt', 'stale\n');
  writeFixture(root, 'sync-standards.lock', 'old lock\n');
  return root;
};

const crashAt = (root: string, phase: string): NodeJS.Signals | null => {
  const child = spawnSync(process.execPath, [fixture, root, phase], {
    stdio: 'pipe',
  });
  return child.signal;
};

const recover = async (rootPath: string): Promise<void> => {
  const root = await openRepositoryRoot(rootPath, 'consumer');
  await recoverRepositoryTransactions(root);
};

describe('durable filesystem transaction recovery', () => {
  for (const phase of [
    'before-journal-temp-open',
    'during-journal-write',
    'before-journal-rename',
    'after-journal-rename',
    'after-journal',
    'after-parent-marker',
    'after-backup-link',
    'after-backup-transaction-fsync',
    'after-backup-unlink',
    'after-backup-parent-fsync',
    'first-install',
    'rollback-restore-after-link',
    'before-lock',
    'after-lock',
  ]) {
    it(`restores the complete old tree after a crash at ${phase}`, async () => {
      const root = setup();
      expect(crashAt(root, phase)).toBe('SIGKILL');

      await recover(root);

      expect(readFixture(root, 'managed/a.txt')).toBe('old a\n');
      expect(readFixture(root, 'managed/b.txt')).toBe('old b\n');
      expect(readFixture(root, 'managed/stale.txt')).toBe('stale\n');
      expect(existsSync(join(root, 'new-parent'))).toBe(false);
      expect(readFixture(root, 'sync-standards.lock')).toBe('old lock\n');
      expect(transactionArtifacts(root)).toEqual([]);
    });
  }

  it('honors a rolled-back cleanup token after an unlink crash', async () => {
    const root = setup();
    expect(crashAt(root, 'rollback-after-cleanup-unlink-new-1')).toBe(
      'SIGKILL',
    );

    await recover(root);

    expect(readFixture(root, 'managed/a.txt')).toBe('old a\n');
    expect(readFixture(root, 'managed/b.txt')).toBe('old b\n');
    expect(readFixture(root, 'managed/stale.txt')).toBe('stale\n');
    expect(readFixture(root, 'sync-standards.lock')).toBe('old lock\n');
    expect(transactionArtifacts(root)).toEqual([]);
  });

  it('removes a bound markerless parent after a mkdir-window crash', async () => {
    const root = setup();
    expect(crashAt(root, 'after-parent-mkdir')).toBe('SIGKILL');

    await recover(root);

    expect(existsSync(join(root, 'new-parent'))).toBe(false);
    expect(transactionArtifacts(root)).toEqual([]);
  });

  it('preserves a replaced empty markerless parent after a crash', async () => {
    const root = setup();
    expect(crashAt(root, 'after-parent-mkdir')).toBe('SIGKILL');
    replaceFixtureDirectory(join(root, 'new-parent'));

    await expect(recover(root)).rejects.toThrow(
      'Filesystem recovery retained .standards-transaction',
    );

    expect(existsSync(join(root, 'new-parent'))).toBe(true);
    expect(transactionArtifacts(root)).toEqual([
      expect.stringMatching(PARENT_BINDING),
      '.standards-transaction',
    ]);
  });
});

describe('durable committed cleanup recovery', () => {
  it('cleans a partial cleanup reservation across repeated recovery', async () => {
    const root = setup();
    expect(crashAt(root, 'during-cleanup-reservation-write')).toBe('SIGKILL');

    await recover(root);
    await recover(root);

    expect(readFixture(root, 'sync-standards.lock')).toBe('new lock\n');
    expect(transactionArtifacts(root)).toEqual([]);
  });

  for (const phase of [
    'after-committed',
    'after-committed-file',
    'after-committed-dir',
    'during-cleanup',
    'before-cleanup-rmdir',
    'after-cleanup-removal',
  ]) {
    it(`keeps the complete new tree after a crash at ${phase}`, async () => {
      const root = setup();
      expect(crashAt(root, phase)).toBe('SIGKILL');

      await recover(root);

      expect(readFixture(root, 'managed/a.txt')).toBe('new a\n');
      expect(readFixture(root, 'managed/b.txt')).toBe('new b\n');
      expect(existsSync(join(root, 'managed/stale.txt'))).toBe(false);
      expect(readFixture(root, 'new-parent/new.txt')).toBe('new nested\n');
      expect(readFixture(root, 'sync-standards.lock')).toBe('new lock\n');
      expect(transactionArtifacts(root)).toEqual([]);
    });
  }

  for (const artifact of [
    'COMMITTED',
    'new-1',
    'new-2',
    'new-3',
    'new-4',
    'old-0',
    'old-1',
    'old-2',
    'old-4',
    'journal.json',
    'OWNER',
  ]) {
    it(`keeps the new tree after cleanup unlinks ${artifact}`, async () => {
      const root = setup();
      expect(crashAt(root, `after-cleanup-unlink-${artifact}`)).toBe('SIGKILL');

      await recover(root);

      expect(readFixture(root, 'managed/a.txt')).toBe('new a\n');
      expect(readFixture(root, 'managed/b.txt')).toBe('new b\n');
      expect(existsSync(join(root, 'managed/stale.txt'))).toBe(false);
      expect(readFixture(root, 'new-parent/new.txt')).toBe('new nested\n');
      expect(readFixture(root, 'sync-standards.lock')).toBe('new lock\n');
      expect(transactionArtifacts(root)).toEqual([]);
    });
  }

  for (const phase of ['after-parent-mkdir', 'after-parent-marker']) {
    it(`preserves a post-crash actor file at ${phase}`, async () => {
      const root = setup();
      expect(crashAt(root, phase)).toBe('SIGKILL');
      writeFixture(root, 'new-parent/actor.txt', 'actor\n');

      await expect(recover(root)).rejects.toThrow(
        'Filesystem recovery retained .standards-transaction',
      );

      expect(readFixture(root, 'new-parent/actor.txt')).toBe('actor\n');
      expect(transactionArtifacts(root)).toEqual([
        expect.stringMatching(PARENT_BINDING),
        '.standards-transaction',
      ]);
    });
  }
});
