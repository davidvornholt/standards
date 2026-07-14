import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  readFixture,
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

const syncDirectory = (path: string): void => {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const recover = async (rootPath: string): Promise<void> => {
  const root = await openRepositoryRoot(rootPath, 'consumer');
  await recoverRepositoryTransactions(root);
};

describe('created-parent terminal cleanup order', () => {
  it('retains the decision reservation after binding unlink', async () => {
    const root = setup();
    const crash = spawnSync(
      process.execPath,
      [fixture, root, 'committed-after-parent-cleanup-binding-unlink'],
      { stdio: 'pipe' },
    );
    expect(crash.signal).toBe('SIGKILL');
    expect([...transactionArtifacts(root)].sort()).toEqual([
      '.standards-transaction',
      '.standards-transaction-reservation',
    ]);

    await recover(root);
    await recover(root);

    expect(readFixture(root, 'new-parent/new.txt')).toBe('new nested\n');
    expect(transactionArtifacts(root)).toEqual([]);
  });

  it('converges a reservation-gone binding-present markerless tail', async () => {
    const root = setup();
    const crash = spawnSync(
      process.execPath,
      [fixture, root, 'committed-after-parent-cleanup-directory-fsync'],
      { stdio: 'pipe' },
    );
    expect(crash.signal).toBe('SIGKILL');

    const journal = JSON.parse(
      readFileSync(join(root, '.standards-transaction/journal.json'), 'utf8'),
    ) as { readonly id: string };
    expect([...transactionArtifacts(root)].sort()).toEqual([
      expect.stringMatching(PARENT_BINDING),
      '.standards-transaction',
      '.standards-transaction-reservation',
    ]);
    unlinkSync(join(root, '.standards-transaction-reservation'));
    syncDirectory(root);

    expect(
      existsSync(join(root, 'new-parent', `.standards-parent-${journal.id}`)),
    ).toBe(false);
    expect([...transactionArtifacts(root)].sort()).toEqual([
      expect.stringMatching(PARENT_BINDING),
      '.standards-transaction',
    ]);

    await recover(root);
    await recover(root);

    expect(readFixture(root, 'new-parent/new.txt')).toBe('new nested\n');
    expect(readFixture(root, 'sync-standards.lock')).toBe('new lock\n');
    expect(transactionArtifacts(root)).toEqual([]);
  });
});
