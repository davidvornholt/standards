import { afterEach, describe, expect, it } from 'bun:test';
import { inspectRepositoryFiles, openRepositoryRoot } from './sync-filesystem';
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
  writeFixture(rootPath, 'managed/nested/a.txt', 'old a\n');
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const states = await inspectRepositoryFiles(root, [
    'managed/nested/a.txt',
    'sync-standards.lock',
  ]);
  const write = (rel: string, contents: string) => ({
    before: requiredState(states, rel),
    contents: Buffer.from(contents),
    mode: requiredState(states, rel).mode,
    rel,
  });
  return {
    plan: {
      deletes: [],
      prunes: [],
      root,
      writes: [
        write('managed/nested/a.txt', 'new a\n'),
        write('sync-standards.lock', 'new lock\n'),
      ],
    },
    root,
    rootPath,
  };
};

const backupBoundaries = [
  'backup-link',
  'backup-transaction-fsync',
  'backup-unlink',
  'backup-parent-fsync',
] as const;

describe('no-loss backup protocol faults', () => {
  for (const operation of backupBoundaries) {
    for (const timing of ['before', 'after'] as const) {
      it(`restores the old tree after ${operation} ${timing}`, async () => {
        const { plan, rootPath } = await setup();
        const fault = (
          candidate: FileOperation,
          rel: string,
          candidateTiming: 'after' | 'before' = 'after',
        ): Promise<void> =>
          candidate === operation &&
          rel === 'managed/nested/a.txt' &&
          candidateTiming === timing
            ? Promise.reject(new Error(`injected ${operation} ${timing}`))
            : Promise.resolve();

        await expect(applyRepositoryMutations(plan, { fault })).rejects.toThrow(
          `injected ${operation} ${timing}`,
        );

        expect(readFixture(rootPath, 'managed/nested/a.txt')).toBe('old a\n');
        expect(readFixture(rootPath, 'sync-standards.lock')).toBe('old lock\n');
        expect(transactionArtifacts(rootPath)).toEqual([]);
      });
    }
  }

  it('recovers a nested restore after its hard link reports failure', async () => {
    const { plan, root, rootPath } = await setup();
    const fault = (
      operation: FileOperation,
      rel: string,
      timing: 'after' | 'before' = 'after',
    ): Promise<void> => {
      if (
        operation === 'install' &&
        rel === 'managed/nested/a.txt' &&
        timing === 'before'
      ) {
        return Promise.reject(new Error('start rollback'));
      }
      if (
        operation === 'rollback-restore' &&
        rel === 'managed/nested/a.txt' &&
        timing === 'after'
      ) {
        return Promise.reject(new Error('restore link fault'));
      }
      return Promise.resolve();
    };

    await expect(applyRepositoryMutations(plan, { fault })).rejects.toThrow(
      'recovery journal retained',
    );
    expect(readFixture(rootPath, 'managed/nested/a.txt')).toBe('old a\n');
    expect(transactionArtifacts(rootPath)).toEqual(['.standards-transaction']);

    await recoverRepositoryTransactions(root);

    expect(readFixture(rootPath, 'managed/nested/a.txt')).toBe('old a\n');
    expect(readFixture(rootPath, 'sync-standards.lock')).toBe('old lock\n');
    expect(transactionArtifacts(rootPath)).toEqual([]);
  });
});
