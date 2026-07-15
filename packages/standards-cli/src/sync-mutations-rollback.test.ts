import { afterEach, describe, expect, it } from 'bun:test';
import { renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRepositoryFiles } from './sync-file-inspection';
import { openRepositoryRoot } from './sync-filesystem';
import {
  applyRepositoryMutations,
  type PreparedDelete,
  type PreparedWrite,
} from './sync-mutations';
import {
  cleanupFixtures,
  readFixture,
  requiredState,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
} from './sync-mutations-test-helpers';

afterEach(cleanupFixtures);

describe('filesystem transaction rollback', () => {
  it('restores prior deletions when a later delete fails', async () => {
    const rootPath = temporaryRoot();
    writeFixture(rootPath, 'managed/a.txt', 'old a\n');
    writeFixture(rootPath, 'managed/stale-1.txt', 'stale 1\n');
    writeFixture(rootPath, 'managed/stale-2.txt', 'stale 2\n');
    writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
    const root = await openRepositoryRoot(rootPath, 'consumer');
    const states = await inspectRepositoryFiles(root, [
      'managed/a.txt',
      'managed/stale-1.txt',
      'managed/stale-2.txt',
      'sync-standards.lock',
    ]);
    const writes: ReadonlyArray<PreparedWrite> = [
      {
        before: requiredState(states, 'managed/a.txt'),
        contents: Buffer.from('new a\n'),
        mode: requiredState(states, 'managed/a.txt').mode,
        rel: 'managed/a.txt',
      },
      {
        before: requiredState(states, 'sync-standards.lock'),
        contents: Buffer.from('new lock\n'),
        mode: requiredState(states, 'sync-standards.lock').mode,
        rel: 'sync-standards.lock',
      },
    ];
    const deletes: ReadonlyArray<PreparedDelete> = [
      {
        before: requiredState(states, 'managed/stale-1.txt'),
        rel: 'managed/stale-1.txt',
      },
      {
        before: requiredState(states, 'managed/stale-2.txt'),
        rel: 'managed/stale-2.txt',
      },
    ];

    await expect(
      applyRepositoryMutations(
        { deletes, prunes: [], root, writes },
        {
          fault: (operation, rel) =>
            operation === 'delete' && rel === 'managed/stale-2.txt'
              ? Promise.reject(new Error('injected delete failure'))
              : Promise.resolve(),
        },
      ),
    ).rejects.toThrow('injected delete failure');

    expect(readFixture(rootPath, 'managed/a.txt')).toBe('old a\n');
    expect(readFixture(rootPath, 'managed/stale-1.txt')).toBe('stale 1\n');
    expect(readFixture(rootPath, 'managed/stale-2.txt')).toBe('stale 2\n');
    expect(readFixture(rootPath, 'sync-standards.lock')).toBe('old lock\n');
    expect(transactionArtifacts(rootPath)).toEqual([]);
  });

  it('never follows a parent swapped at the commit boundary', async () => {
    const rootPath = temporaryRoot();
    const victim = temporaryRoot();
    writeFixture(rootPath, 'managed/a.txt', 'old\n');
    writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
    writeFixture(victim, 'a.txt', 'external\n');
    const root = await openRepositoryRoot(rootPath, 'consumer');
    const states = await inspectRepositoryFiles(root, [
      'managed/a.txt',
      'sync-standards.lock',
    ]);

    await expect(
      applyRepositoryMutations(
        {
          deletes: [],
          prunes: [],
          root,
          writes: [
            {
              before: requiredState(states, 'managed/a.txt'),
              contents: Buffer.from('new\n'),
              mode: requiredState(states, 'managed/a.txt').mode,
              rel: 'managed/a.txt',
            },
            {
              before: requiredState(states, 'sync-standards.lock'),
              contents: Buffer.from('new lock\n'),
              mode: requiredState(states, 'sync-standards.lock').mode,
              rel: 'sync-standards.lock',
            },
          ],
        },
        {
          beforeCommitMarker: () => {
            renameSync(join(rootPath, 'managed'), join(rootPath, 'moved'));
            symlinkSync(victim, join(rootPath, 'managed'));
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow('must not be a symbolic link');

    expect(readFixture(victim, 'a.txt')).toBe('external\n');
    expect(readFixture(rootPath, 'moved/a.txt')).toBe('old\n');
    expect(readFixture(rootPath, 'sync-standards.lock')).toBe('old lock\n');
    expect(transactionArtifacts(rootPath)).toEqual([]);
  });
});
