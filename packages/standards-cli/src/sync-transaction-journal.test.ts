import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRepositoryFiles, openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  requiredState,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
  writeTransactionOwnerFixture,
} from './sync-mutations-test-helpers';
import { buildJournal } from './sync-transaction-build';
import { parseJournal } from './sync-transaction-journal-parser';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';
import {
  TRANSACTION_COMMITTED,
  TRANSACTION_DIRECTORY,
  TRANSACTION_JOURNAL,
  TRANSACTION_JOURNAL_TEMP,
  TRANSACTION_OWNER,
} from './sync-transaction-types';

afterEach(cleanupFixtures);

const journalFixture = async () => {
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
  return { journal, root, rootPath, transaction };
};

describe('transaction journal validation', () => {
  it('fails closed and preserves corrupt journal bytes', async () => {
    const { root, rootPath, transaction } = await journalFixture();
    writeFileSync(join(transaction, TRANSACTION_JOURNAL), '{not json');

    await expect(recoverRepositoryTransactions(root)).rejects.toThrow();

    expect(transactionArtifacts(rootPath)).toEqual(['.standards-transaction']);
  });
});

describe('transaction journal recovery hardening', () => {
  it('rejects a traversal path without touching the journal', async () => {
    const { journal, root, rootPath, transaction } = await journalFixture();
    const [operation] = journal.operations;
    if (operation === undefined) {
      throw new Error('Expected a journal operation');
    }
    const traversal = {
      ...journal,
      operations: [{ ...operation, rel: '../victim' }],
    };
    writeFileSync(
      join(transaction, TRANSACTION_JOURNAL),
      JSON.stringify(traversal),
    );

    await expect(recoverRepositoryTransactions(root)).rejects.toThrow(
      'normalized repository-relative path',
    );

    expect(transactionArtifacts(rootPath)).toEqual(['.standards-transaction']);
  });

  it('makes read-only commands fail closed on a pending journal', async () => {
    const { journal, root, rootPath, transaction } = await journalFixture();
    writeFileSync(
      join(transaction, TRANSACTION_JOURNAL),
      JSON.stringify(journal),
    );

    await expect(recoverRepositoryTransactions(root, false)).rejects.toThrow(
      'Pending filesystem recovery',
    );

    expect(transactionArtifacts(rootPath)).toEqual(['.standards-transaction']);
  });

  it('preserves an unowned temporary-journal directory', async () => {
    const { root, rootPath, transaction } = await journalFixture();
    unlinkSync(join(transaction, TRANSACTION_OWNER));
    writeFileSync(join(transaction, TRANSACTION_JOURNAL_TEMP), '{partial');

    await expect(recoverRepositoryTransactions(root)).rejects.toThrow();

    expect(transactionArtifacts(rootPath)).toEqual([TRANSACTION_DIRECTORY]);
  });

  it('rejects symlink and FIFO journal entries without following or blocking', async () => {
    const symlink = await journalFixture();
    symlinkSync(
      join(symlink.rootPath, 'sync-standards.lock'),
      join(symlink.transaction, TRANSACTION_JOURNAL),
    );
    await expect(recoverRepositoryTransactions(symlink.root)).rejects.toThrow();

    const fifo = await journalFixture();
    spawnSync('mkfifo', [join(fifo.transaction, TRANSACTION_JOURNAL)]);
    await expect(recoverRepositoryTransactions(fifo.root)).rejects.toThrow(
      'regular file',
    );
  });

  it('rejects a non-regular committed decision marker', async () => {
    const { journal, root, rootPath, transaction } = await journalFixture();
    writeFileSync(
      join(transaction, TRANSACTION_JOURNAL),
      JSON.stringify(journal),
    );
    symlinkSync(
      join(rootPath, 'sync-standards.lock'),
      join(transaction, TRANSACTION_COMMITTED),
    );

    await expect(recoverRepositoryTransactions(root)).rejects.toThrow();
  });
});

describe('transaction journal semantic ownership', () => {
  it('requires a final lock decision and consistent created parents', async () => {
    const { journal } = await journalFixture();
    const [lock] = journal.operations;
    if (lock === undefined) {
      throw new Error('Expected a lock operation');
    }
    const nested = {
      ...lock,
      backup: 'old-0',
      rel: 'managed/nested/file.txt',
      stage: 'new-0',
    };
    const finalLock = { ...lock, backup: 'old-1', stage: 'new-1' };
    const reject = (value: unknown, message: string): void => {
      expect(() => parseJournal(JSON.stringify(value))).toThrow(message);
    };
    reject({ ...journal, lockRel: 'other' }, 'lockRel is invalid');
    reject(
      {
        ...journal,
        operations: [lock, { ...nested, backup: 'old-1', stage: 'new-1' }],
      },
      'final lockfile write',
    );
    reject(
      {
        ...journal,
        createdParents: ['managed'],
        operations: [nested, finalLock],
      },
      'created parents are inconsistent',
    );
    reject(
      {
        ...journal,
        createdParents: [TRANSACTION_DIRECTORY],
        operations: [nested, finalLock],
      },
      'created parent is reserved',
    );
  });
});
