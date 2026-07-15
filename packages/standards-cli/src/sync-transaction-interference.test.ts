import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRepositoryFiles } from './sync-file-inspection';
import { openRepositoryRoot } from './sync-filesystem';
import { applyRepositoryMutations, type PreparedWrite } from './sync-mutations';
import {
  cleanupFixtures,
  readFixture,
  replaceFixtureFile,
  requiredState,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
} from './sync-mutations-test-helpers';
import type { FileOperation } from './sync-transaction-types';

afterEach(cleanupFixtures);

const setupWrites = async (rootPath: string) => {
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const states = await inspectRepositoryFiles(root, [
    'managed/a.txt',
    'managed/b.txt',
    'managed/new.txt',
    'sync-standards.lock',
  ]);
  const write = (rel: string, contents: string): PreparedWrite => ({
    before: requiredState(states, rel),
    contents: Buffer.from(contents),
    mode: requiredState(states, rel).mode,
    rel,
  });
  return { root, states, write };
};

describe('transaction interference safety', () => {
  it('preserves a content edit made after preflight', async () => {
    const rootPath = temporaryRoot();
    writeFixture(rootPath, 'managed/a.txt', 'old\n');
    writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
    const { root, write } = await setupWrites(rootPath);

    await expect(
      applyRepositoryMutations(
        {
          deletes: [],
          prunes: [],
          root,
          writes: [
            write('managed/a.txt', 'new\n'),
            write('sync-standards.lock', 'new lock\n'),
          ],
        },
        {
          beforeMutation: () => {
            writeFileSync(join(rootPath, 'managed/a.txt'), 'actor edit\n');
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow('recovery journal retained');

    expect(readFixture(rootPath, 'managed/a.txt')).toBe('actor edit\n');
    expect(readFixture(rootPath, 'sync-standards.lock')).toBe('old lock\n');
    expect(transactionArtifacts(rootPath)).toEqual(['.standards-transaction']);
  });

  it('preserves an inode replacement before delete', async () => {
    const rootPath = temporaryRoot();
    writeFixture(rootPath, 'managed/a.txt', 'old\n');
    writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
    const { root, states, write } = await setupWrites(rootPath);

    await expect(
      applyRepositoryMutations(
        {
          deletes: [
            {
              before: requiredState(states, 'managed/a.txt'),
              rel: 'managed/a.txt',
            },
          ],
          prunes: [],
          root,
          writes: [write('sync-standards.lock', 'new lock\n')],
        },
        {
          beforeMutation: () => {
            replaceFixtureFile(
              join(rootPath, 'managed/a.txt'),
              'actor replacement\n',
            );
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow('recovery journal retained');

    expect(readFixture(rootPath, 'managed/a.txt')).toBe('actor replacement\n');
    expect(readFixture(rootPath, 'sync-standards.lock')).toBe('old lock\n');
  });
});

describe('backup interference safety', () => {
  it('preserves a replacement raced into the removal boundary', async () => {
    const rootPath = temporaryRoot();
    writeFixture(rootPath, 'managed/a.txt', 'old\n');
    writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
    const { root, write } = await setupWrites(rootPath);
    const fault = (
      operation: FileOperation,
      rel: string,
      timing: 'after' | 'before' = 'after',
    ): Promise<void> => {
      if (
        operation === 'backup-unlink' &&
        rel === 'managed/a.txt' &&
        timing === 'before'
      ) {
        replaceFixtureFile(join(rootPath, rel), 'actor replacement\n');
      }
      return Promise.resolve();
    };

    await expect(
      applyRepositoryMutations(
        {
          deletes: [],
          prunes: [],
          root,
          writes: [
            write('managed/a.txt', 'new\n'),
            write('sync-standards.lock', 'new lock\n'),
          ],
        },
        { fault },
      ),
    ).rejects.toThrow('recovery journal retained');

    expect(readFixture(rootPath, 'managed/a.txt')).toBe('actor replacement\n');
    expect(readFixture(rootPath, 'sync-standards.lock')).toBe('old lock\n');
    expect(transactionArtifacts(rootPath)).toEqual(['.standards-transaction']);
    const transaction = join(rootPath, '.standards-transaction');
    const journal = JSON.parse(
      readFileSync(join(transaction, 'journal.json'), 'utf8'),
    ) as {
      readonly operations: ReadonlyArray<{ backup: string; rel: string }>;
    };
    const backupOperation = journal.operations.find(
      (candidate) => candidate.rel === 'managed/a.txt',
    );
    expect(
      readFileSync(join(transaction, backupOperation?.backup ?? '')),
    ).toEqual(Buffer.from('old\n'));
  });
});

describe('new-target interference safety', () => {
  it('never overwrites a file appearing at an absent target', async () => {
    const rootPath = temporaryRoot();
    writeFixture(rootPath, 'managed/a.txt', 'old\n');
    writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
    const { root, write } = await setupWrites(rootPath);
    const fault = (
      operation: FileOperation,
      rel: string,
      timing: 'after' | 'before' = 'after',
    ): Promise<void> => {
      if (
        operation === 'install' &&
        timing === 'before' &&
        rel === 'managed/new.txt'
      ) {
        writeFileSync(join(rootPath, rel), 'actor file\n');
      }
      return Promise.resolve();
    };

    await expect(
      applyRepositoryMutations(
        {
          deletes: [],
          prunes: [],
          root,
          writes: [
            write('managed/new.txt', 'canonical\n'),
            write('sync-standards.lock', 'new lock\n'),
          ],
        },
        { fault },
      ),
    ).rejects.toThrow('recovery journal retained');

    expect(readFixture(rootPath, 'managed/new.txt')).toBe('actor file\n');
    expect(readFixture(rootPath, 'sync-standards.lock')).toBe('old lock\n');
  });
});
