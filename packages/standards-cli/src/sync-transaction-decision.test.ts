import { afterEach, expect, it } from 'bun:test';
import { renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
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

afterEach(cleanupFixtures);

it('retains WAL when a parent is swapped after the lock install', async () => {
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
        beforeCommitDecision: () => {
          renameSync(join(rootPath, 'managed'), join(rootPath, 'moved'));
          symlinkSync(victim, join(rootPath, 'managed'));
          return Promise.resolve();
        },
      },
    ),
  ).rejects.toThrow('must not be a symbolic link');

  expect(readFixture(victim, 'a.txt')).toBe('external\n');
  expect(readFixture(rootPath, 'moved/a.txt')).toBe('new\n');
  expect(readFixture(rootPath, 'sync-standards.lock')).toBe('new lock\n');
  expect(transactionArtifacts(rootPath)).toEqual(['.standards-transaction']);
});

it('retains committed WAL when a parent is swapped after its marker', async () => {
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
        afterCommitMarker: () => {
          renameSync(join(rootPath, 'managed'), join(rootPath, 'moved'));
          symlinkSync(victim, join(rootPath, 'managed'));
          return Promise.resolve();
        },
      },
    ),
  ).rejects.toThrow('must not be a symbolic link');

  expect(readFixture(victim, 'a.txt')).toBe('external\n');
  expect(readFixture(rootPath, 'moved/a.txt')).toBe('new\n');
  expect(readFixture(rootPath, 'sync-standards.lock')).toBe('new lock\n');
  expect(transactionArtifacts(rootPath)).toEqual(['.standards-transaction']);
});

it('detects a parent actor after the managed file install', async () => {
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
        fault: (operation, rel, timing) => {
          if (
            operation === 'install' &&
            rel === 'managed/a.txt' &&
            timing === 'after'
          ) {
            renameSync(join(rootPath, 'managed'), join(rootPath, 'moved'));
            symlinkSync(victim, join(rootPath, 'managed'));
          }
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
