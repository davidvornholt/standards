import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRepositoryFiles } from './sync-file-inspection';
import { openRepositoryRoot } from './sync-filesystem';
import { applyRepositoryMutations } from './sync-mutations';
import {
  cleanupFixtures,
  readFixture,
  replaceFixtureFile,
  requiredState,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
} from './sync-mutations-test-helpers';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';
import type { FileOperation } from './sync-transaction-types';

afterEach(cleanupFixtures);

const setup = async (newTarget: boolean) => {
  const rootPath = temporaryRoot();
  if (!newTarget) {
    writeFixture(rootPath, 'managed.txt', 'old\n');
  }
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const states = await inspectRepositoryFiles(root, [
    'managed.txt',
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
        write('managed.txt', 'new\n'),
        write('sync-standards.lock', 'new lock\n'),
      ],
    },
    root,
    rootPath,
  };
};

describe('rollback unlink interference', () => {
  it('preserves a new-target replacement at the removal boundary', async () => {
    const { plan, root, rootPath } = await setup(true);
    const fault = (
      operation: FileOperation,
      rel: string,
      timing: 'after' | 'before' = 'after',
    ): Promise<void> => {
      if (
        operation === 'install' &&
        rel === 'sync-standards.lock' &&
        timing === 'before'
      ) {
        return Promise.reject(new Error('start rollback'));
      }
      if (
        operation === 'rollback-remove' &&
        rel === 'managed.txt' &&
        timing === 'before'
      ) {
        renameSync(
          join(rootPath, 'managed.txt'),
          join(rootPath, 'installed-moved.txt'),
        );
        writeFileSync(join(rootPath, 'managed.txt'), 'actor replacement\n');
      }
      return Promise.resolve();
    };

    await expect(applyRepositoryMutations(plan, { fault })).rejects.toThrow(
      'recovery journal retained',
    );
    expect(readFixture(rootPath, 'managed.txt')).toBe('actor replacement\n');
    expect(transactionArtifacts(rootPath)).toEqual(['.standards-transaction']);

    const expectRetained = async (): Promise<void> => {
      await expect(recoverRepositoryTransactions(root)).rejects.toMatchObject({
        errors: [
          expect.objectContaining({
            message: expect.stringContaining('unexpected new file'),
          }),
        ],
      });
      expect(readFixture(rootPath, 'managed.txt')).toBe('actor replacement\n');
      expect(transactionArtifacts(rootPath)).toEqual([
        '.standards-transaction',
      ]);
    };
    await expectRetained();
    await expectRetained();
  });

  it('preserves a backup replacement after restore linking', async () => {
    const { plan, root, rootPath } = await setup(false);
    const backup = join(rootPath, '.standards-transaction/old-0');
    const fault = (
      operation: FileOperation,
      rel: string,
      timing: 'after' | 'before' = 'after',
    ): Promise<void> => {
      if (
        operation === 'install' &&
        rel === 'managed.txt' &&
        timing === 'before'
      ) {
        return Promise.reject(new Error('start rollback'));
      }
      if (
        operation === 'rollback-restore' &&
        rel === 'managed.txt' &&
        timing === 'after'
      ) {
        replaceFixtureFile(backup, 'actor backup\n');
      }
      return Promise.resolve();
    };

    await expect(applyRepositoryMutations(plan, { fault })).rejects.toThrow(
      'recovery journal retained',
    );
    expect(readFixture(rootPath, 'managed.txt')).toBe('old\n');
    expect(readFixture(rootPath, '.standards-transaction/old-0')).toBe(
      'actor backup\n',
    );
    expect(existsSync(backup)).toBe(true);

    const expectRetained = async (): Promise<void> => {
      await expect(recoverRepositoryTransactions(root)).rejects.toMatchObject({
        errors: [
          expect.objectContaining({
            message: expect.stringContaining('backup does not match preflight'),
          }),
        ],
      });
      expect(readFixture(rootPath, 'managed.txt')).toBe('old\n');
      expect(readFixture(rootPath, '.standards-transaction/old-0')).toBe(
        'actor backup\n',
      );
    };
    await expectRetained();
    await expectRetained();
  });
});
