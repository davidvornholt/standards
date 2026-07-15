import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { inspectRepositoryFiles } from './sync-file-inspection';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  requiredState,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
  writeTransactionOwnerFixture,
} from './sync-mutations-test-helpers';
import { buildJournal } from './sync-transaction-build';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';
import {
  TRANSACTION_COMMITTED,
  TRANSACTION_DIRECTORY,
  TRANSACTION_JOURNAL,
} from './sync-transaction-types';

afterEach(cleanupFixtures);

const setup = async () => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const states = await inspectRepositoryFiles(root, ['sync-standards.lock']);
  const journal = buildJournal({
    createdParents: [],
    deletes: [],
    id: '00000000-0000-4000-8000-000000000000',
    root,
    writes: [
      {
        before: requiredState(states, 'sync-standards.lock'),
        contents: Buffer.from('new lock\n'),
        mode: requiredState(states, 'sync-standards.lock').mode,
        rel: 'sync-standards.lock',
      },
    ],
  });
  const transaction = join(rootPath, TRANSACTION_DIRECTORY);
  mkdirSync(transaction);
  writeTransactionOwnerFixture(rootPath, transaction, journal.id);
  writeFileSync(
    join(transaction, TRANSACTION_JOURNAL),
    JSON.stringify(journal),
  );
  return { root, rootPath, transaction };
};

describe('transaction decision node validation', () => {
  it('rejects a journal symlink whose target contains valid JSON', async () => {
    const { root, rootPath, transaction } = await setup();
    const journal = join(transaction, TRANSACTION_JOURNAL);
    const target = join(rootPath, 'valid-journal.json');
    writeFileSync(target, readFileSync(journal));
    unlinkSync(journal);
    symlinkSync(target, journal);

    await expect(recoverRepositoryTransactions(root)).rejects.toThrow();

    expect(transactionArtifacts(rootPath)).toEqual([TRANSACTION_DIRECTORY]);
  });

  it('rejects an empty committed-marker symlink', async () => {
    const { root, rootPath, transaction } = await setup();
    const target = join(rootPath, 'empty-marker');
    writeFileSync(target, '');
    symlinkSync(target, join(transaction, TRANSACTION_COMMITTED));

    await expect(recoverRepositoryTransactions(root)).rejects.toThrow();

    expect(transactionArtifacts(rootPath)).toEqual([TRANSACTION_DIRECTORY]);
  });

  for (const kind of ['fifo', 'directory'] as const) {
    it(`rejects a ${kind} committed marker without blocking`, async () => {
      const { root, rootPath, transaction } = await setup();
      const marker = join(transaction, TRANSACTION_COMMITTED);
      if (kind === 'fifo') {
        if (spawnSync('mkfifo', [marker]).status !== 0) {
          throw new Error('Could not create FIFO fixture');
        }
      } else {
        mkdirSync(marker);
      }

      await expect(recoverRepositoryTransactions(root)).rejects.toThrow(
        'Transaction entry must be a regular file: COMMITTED',
      );
      expect(transactionArtifacts(rootPath)).toEqual([TRANSACTION_DIRECTORY]);
    });
  }

  it('preserves a preexisting active reserved directory', async () => {
    const rootPath = temporaryRoot();
    writeFixture(rootPath, `${TRANSACTION_DIRECTORY}/actor.txt`, 'actor\n');
    const root = await openRepositoryRoot(rootPath, 'consumer');

    await expect(recoverRepositoryTransactions(root)).rejects.toThrow();

    expect(transactionArtifacts(rootPath)).toEqual([TRANSACTION_DIRECTORY]);
  });
});
