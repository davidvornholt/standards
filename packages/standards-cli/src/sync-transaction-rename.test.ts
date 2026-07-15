import { afterEach, describe, expect, it } from 'bun:test';
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
import type { FileOperation } from './sync-transaction-types';

afterEach(cleanupFixtures);

const setup = async () => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'managed/a.txt', 'old a\n');
  writeFixture(rootPath, 'managed/b.txt', 'old b\n');
  writeFixture(rootPath, 'managed/stale.txt', 'stale\n');
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const states = await inspectRepositoryFiles(root, [
    'managed/a.txt',
    'managed/b.txt',
    'managed/stale.txt',
    'sync-standards.lock',
  ]);
  return {
    plan: {
      deletes: [
        {
          before: requiredState(states, 'managed/stale.txt'),
          rel: 'managed/stale.txt',
        },
      ],
      prunes: [],
      root,
      writes: [
        {
          before: requiredState(states, 'managed/a.txt'),
          contents: Buffer.from('new a\n'),
          mode: requiredState(states, 'managed/a.txt').mode,
          rel: 'managed/a.txt',
        },
        {
          before: requiredState(states, 'managed/b.txt'),
          contents: Buffer.from('new b\n'),
          mode: requiredState(states, 'managed/b.txt').mode,
          rel: 'managed/b.txt',
        },
        {
          before: requiredState(states, 'sync-standards.lock'),
          contents: Buffer.from('new lock\n'),
          mode: requiredState(states, 'sync-standards.lock').mode,
          rel: 'sync-standards.lock',
        },
      ],
    },
    root,
    rootPath,
  };
};

const treeContents = (rootPath: string): ReadonlyArray<string> => [
  readFixture(rootPath, 'managed/a.txt'),
  readFixture(rootPath, 'managed/b.txt'),
  readFixture(rootPath, 'managed/stale.txt'),
  readFixture(rootPath, 'sync-standards.lock'),
];

const OLD_TREE = ['old a\n', 'old b\n', 'stale\n', 'old lock\n'] as const;

describe('transaction file-operation failures', () => {
  it('orders durable target fsyncs before the commit decision', async () => {
    const { plan } = await setup();
    const events: Array<string> = [];
    const fault = (
      operation: FileOperation,
      rel: string,
      timing: 'after' | 'before' = 'after',
    ): Promise<void> => {
      events.push(`${operation}:${timing}:${rel}`);
      return Promise.resolve();
    };

    await applyRepositoryMutations(plan, {
      afterCommitted: () => {
        events.push('committed');
        return Promise.resolve();
      },
      afterJournal: () => {
        events.push('journal');
        return Promise.resolve();
      },
      fault,
    });

    expect(events.indexOf('journal')).toBeLessThan(
      events.indexOf('backup-link:before:managed/stale.txt'),
    );
    expect(
      events.filter(
        (event) =>
          event.startsWith('backup-') && event.endsWith(':managed/a.txt'),
      ),
    ).toEqual([
      'backup-link:before:managed/a.txt',
      'backup-link:after:managed/a.txt',
      'backup-transaction-fsync:before:managed/a.txt',
      'backup-transaction-fsync:after:managed/a.txt',
      'backup-unlink:before:managed/a.txt',
      'backup-unlink:after:managed/a.txt',
      'backup-parent-fsync:before:managed/a.txt',
      'backup-parent-fsync:after:managed/a.txt',
    ]);
    expect(
      events.indexOf('backup-parent-fsync:after:managed/a.txt'),
    ).toBeLessThan(events.indexOf('install:before:managed/a.txt'));
    expect(events.indexOf('install:after:managed/a.txt')).toBeLessThan(
      events.lastIndexOf('fsync:after:managed/a.txt'),
    );
    expect(events.lastIndexOf('fsync:after:sync-standards.lock')).toBeLessThan(
      events.indexOf('committed'),
    );
  });

  for (const [operation, timing, rel] of [
    ['install', 'before', 'managed/a.txt'],
    ['install', 'after', 'managed/b.txt'],
    ['backup-unlink', 'after', 'sync-standards.lock'],
    ['install', 'after', 'sync-standards.lock'],
  ] as const) {
    it(`rolls back a ${timing} ${operation} failure at ${rel}`, async () => {
      const { plan, rootPath } = await setup();
      const fault = (
        candidate: FileOperation,
        candidateRel: string,
        candidateTiming: 'after' | 'before' = 'after',
      ): Promise<void> =>
        candidate === operation &&
        candidateRel === rel &&
        candidateTiming === timing
          ? Promise.reject(new Error(`injected ${operation} ${timing}`))
          : Promise.resolve();

      await expect(applyRepositoryMutations(plan, { fault })).rejects.toThrow(
        `injected ${operation} ${timing}`,
      );

      expect(treeContents(rootPath)).toEqual(OLD_TREE);
      expect(transactionArtifacts(rootPath)).toEqual([]);
    });
  }
});

describe('rollback fault aggregation', () => {
  it('aggregates rollback failures, retains the journal, then recovers', async () => {
    const { plan, root, rootPath } = await setup();
    const fault = (
      operation: FileOperation,
      rel: string,
      timing: 'after' | 'before' = 'after',
    ): Promise<void> => {
      if (
        operation === 'install' &&
        timing === 'after' &&
        rel === 'managed/a.txt'
      ) {
        return Promise.reject(new Error('primary install failure'));
      }
      if (
        operation === 'rollback-remove' &&
        timing === 'before' &&
        rel === 'managed/a.txt'
      ) {
        return Promise.reject(new Error('injected rollback failure'));
      }
      return Promise.resolve();
    };

    let failure: unknown;
    try {
      await applyRepositoryMutations(plan, { fault });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(String(failure)).toContain('recovery journal retained');
    expect(transactionArtifacts(rootPath)).toEqual(['.standards-transaction']);

    await recoverRepositoryTransactions(root);

    expect(treeContents(rootPath)).toEqual(OLD_TREE);
    expect(transactionArtifacts(rootPath)).toEqual([]);
  });
});
