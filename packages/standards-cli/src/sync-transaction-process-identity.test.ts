import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
} from './sync-mutations-test-helpers';
import { captureLinuxProcessIdentity } from './sync-process-identity';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';

const fixture = join(import.meta.dir, 'sync-transaction-crash-fixture.ts');

afterEach(cleanupFixtures);

const pendingTransaction = () => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'managed/a.txt', 'old a\n');
  writeFixture(rootPath, 'managed/b.txt', 'old b\n');
  writeFixture(rootPath, 'managed/stale.txt', 'stale\n');
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const crash = spawnSync(
    process.execPath,
    [fixture, rootPath, 'after-journal'],
    {
      stdio: 'pipe',
    },
  );
  if (crash.signal !== 'SIGKILL') {
    throw new Error('Transaction crash fixture did not stop at after-journal');
  }
  return {
    journalPath: join(rootPath, '.standards-transaction/journal.json'),
    rootPath,
  };
};

const rewriteOwner = (
  journalPath: string,
  update: (journal: Record<string, unknown>) => void,
): void => {
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<
    string,
    unknown
  >;
  update(journal);
  writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
};

describe('transaction owner process identity', () => {
  it('recovers when a live PID has a different start time', async () => {
    const { journalPath, rootPath } = pendingTransaction();
    const current = captureLinuxProcessIdentity();
    rewriteOwner(journalPath, (journal) => {
      journal.ownerPid = process.pid;
      journal.ownerProcess = {
        ...current,
        startTime: current.startTime === '0' ? '1' : '0',
      };
    });

    const root = await openRepositoryRoot(rootPath, 'consumer');
    await recoverRepositoryTransactions(root);

    expect(transactionArtifacts(rootPath)).toEqual([]);
  });

  it('allows the current v2 writer identity to resume recovery', async () => {
    const { journalPath, rootPath } = pendingTransaction();
    rewriteOwner(journalPath, (journal) => {
      journal.ownerPid = process.pid;
      journal.ownerProcess = captureLinuxProcessIdentity();
    });

    const root = await openRepositoryRoot(rootPath, 'consumer');
    await recoverRepositoryTransactions(root);

    expect(transactionArtifacts(rootPath)).toEqual([]);
  });

  it('fails closed for a live legacy journal owner', async () => {
    const { journalPath, rootPath } = pendingTransaction();
    rewriteOwner(journalPath, (journal) => {
      journal.ownerPid = process.pid;
      journal.ownerProcess = undefined;
      journal.version = 1;
    });

    const root = await openRepositoryRoot(rootPath, 'consumer');
    await expect(recoverRepositoryTransactions(root)).rejects.toThrow(
      'Another standards sync owns .standards-transaction',
    );
    expect(transactionArtifacts(rootPath)).toEqual(['.standards-transaction']);
  });
});
