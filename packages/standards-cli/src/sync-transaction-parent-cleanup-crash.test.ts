import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const crashAt = (root: string, phase: string): NodeJS.Signals | null =>
  spawnSync(process.execPath, [fixture, root, phase], { stdio: 'pipe' }).signal;

const recover = async (rootPath: string): Promise<void> => {
  const root = await openRepositoryRoot(rootPath, 'consumer');
  await recoverRepositoryTransactions(root);
};

const oldTreeState = (root: string) => ({
  a: readFixture(root, 'managed/a.txt'),
  b: readFixture(root, 'managed/b.txt'),
  lock: readFixture(root, 'sync-standards.lock'),
  newParent: existsSync(join(root, 'new-parent')),
  stale: readFixture(root, 'managed/stale.txt'),
});

describe('durable created-parent cleanup', () => {
  for (const operation of [
    'parent-cleanup-token-write',
    'parent-cleanup-token',
    'parent-cleanup-directory-fsync',
    'parent-cleanup-rmdir',
    'parent-cleanup-parent-fsync',
    'parent-cleanup-binding-unlink',
    'parent-cleanup-binding-fsync',
    'parent-cleanup-reservation-unlink',
    'parent-cleanup-reservation-fsync',
    'parent-cleanup-token-unlink',
  ]) {
    it(`recovers repeatedly after ${operation}`, async () => {
      const root = setup();
      expect(crashAt(root, `rollback-after-${operation}`)).toBe('SIGKILL');

      await recover(root);
      await recover(root);

      expect(oldTreeState(root)).toEqual({
        a: 'old a\n',
        b: 'old b\n',
        lock: 'old lock\n',
        newParent: false,
        stale: 'stale\n',
      });
      expect(transactionArtifacts(root)).toEqual([]);
    });
  }

  it('rejects a valid-shaped replacement parent inode', async () => {
    const root = setup();
    expect(crashAt(root, 'rollback-after-parent-cleanup-directory-fsync')).toBe(
      'SIGKILL',
    );
    const parent = join(root, 'new-parent');
    replaceFixtureDirectory(parent);

    await expect(recover(root)).rejects.toThrow(
      'Filesystem recovery retained .standards-transaction',
    );

    expect(existsSync(parent)).toBe(true);
    expect([...transactionArtifacts(root)].sort()).toEqual([
      expect.stringMatching(PARENT_BINDING),
      '.standards-transaction',
      '.standards-transaction-reservation',
    ]);
  });
});

describe('durable created-parent binding', () => {
  it('rejects a valid-marker replacement before cleanup-token publication', async () => {
    const root = setup();
    expect(crashAt(root, 'after-parent-marker')).toBe('SIGKILL');
    const journal = JSON.parse(
      readFileSync(join(root, '.standards-transaction/journal.json'), 'utf8'),
    ) as { readonly id: string };
    const parent = join(root, 'new-parent');
    replaceFixtureDirectory(parent);
    writeFileSync(join(parent, `.standards-parent-${journal.id}`), journal.id);

    await expect(recover(root)).rejects.toThrow(
      'Filesystem recovery retained .standards-transaction',
    );

    expect(existsSync(parent)).toBe(true);
    expect(transactionArtifacts(root)).toContain('.standards-transaction');
    expect(transactionArtifacts(root)).not.toContain(
      '.standards-transaction-reservation',
    );
  });

  it('preserves an existing parent when its durable binding is missing', async () => {
    const root = setup();
    expect(crashAt(root, 'after-parent-mkdir')).toBe('SIGKILL');
    const binding = transactionArtifacts(root).find((name) =>
      name.startsWith('.standards-parent-binding-'),
    );
    expect(binding).toBeDefined();
    rmSync(join(root, binding as string));

    await expect(recover(root)).rejects.toThrow(
      'Filesystem recovery retained .standards-transaction',
    );

    expect(existsSync(join(root, 'new-parent'))).toBe(true);
    expect(transactionArtifacts(root)).toEqual(['.standards-transaction']);
  });

  it('preserves a valid-shaped committed parent replacement', async () => {
    const root = setup();
    expect(crashAt(root, 'committed-after-parent-cleanup-token')).toBe(
      'SIGKILL',
    );
    const journal = JSON.parse(
      readFileSync(join(root, '.standards-transaction/journal.json'), 'utf8'),
    ) as { readonly id: string };
    const parent = join(root, 'new-parent');
    replaceFixtureDirectory(parent);
    writeFileSync(join(parent, `.standards-parent-${journal.id}`), journal.id);
    writeFileSync(join(parent, 'new.txt'), 'new nested\n');

    await expect(recover(root)).rejects.toThrow(
      'Filesystem recovery retained .standards-transaction',
    );

    expect(existsSync(parent)).toBe(true);
    expect(transactionArtifacts(root)).toContain('.standards-transaction');
    expect(transactionArtifacts(root)).toContain(
      '.standards-transaction-reservation',
    );
  });

  for (const operation of [
    'parent-cleanup-token-write',
    'parent-cleanup-token',
    'parent-cleanup-marker-unlink',
    'parent-cleanup-directory-fsync',
    'parent-cleanup-binding-unlink',
    'parent-cleanup-binding-fsync',
    'parent-cleanup-reservation-unlink',
    'parent-cleanup-reservation-fsync',
    'parent-cleanup-token-unlink',
  ]) {
    it(`keeps committed parent state after ${operation}`, async () => {
      const root = setup();
      expect(crashAt(root, `committed-after-${operation}`)).toBe('SIGKILL');

      await recover(root);
      await recover(root);

      expect(readFixture(root, 'new-parent/new.txt')).toBe('new nested\n');
      expect(readFixture(root, 'sync-standards.lock')).toBe('new lock\n');
      expect(transactionArtifacts(root)).toEqual([]);
    });
  }
});
