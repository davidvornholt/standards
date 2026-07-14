import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
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
import type { FileOperation } from './sync-transaction-files';

const EXECUTABLE_MODE = 0o755;
const PUBLIC_MODE = 0o644;
const PRIVATE_MODE = 0o600;
const RESTRICTIVE_UMASK = 0o077;
const FILE_TYPE_MODE_BASE = 0o1000;

afterEach(cleanupFixtures);

describe('filesystem transaction staging', () => {
  it('preserves exact modes while default creation still honors umask', async () => {
    const rootPath = temporaryRoot();
    writeFixture(rootPath, 'existing.txt', 'old\n');
    writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
    chmodSync(join(rootPath, 'existing.txt'), EXECUTABLE_MODE);
    const root = await openRepositoryRoot(rootPath, 'consumer');
    const states = await inspectRepositoryFiles(root, [
      'existing.txt',
      'exact-new.txt',
      'default-new.txt',
      'sync-standards.lock',
    ]);
    const previousUmask = process.umask(RESTRICTIVE_UMASK);
    try {
      await applyRepositoryMutations({
        deletes: [],
        prunes: [],
        root,
        writes: [
          {
            before: requiredState(states, 'existing.txt'),
            contents: Buffer.from('new\n'),
            mode: EXECUTABLE_MODE,
            rel: 'existing.txt',
          },
          {
            before: requiredState(states, 'exact-new.txt'),
            contents: Buffer.from('exact\n'),
            mode: PUBLIC_MODE,
            rel: 'exact-new.txt',
          },
          {
            before: requiredState(states, 'default-new.txt'),
            contents: Buffer.from('default\n'),
            mode: null,
            rel: 'default-new.txt',
          },
          {
            before: requiredState(states, 'sync-standards.lock'),
            contents: Buffer.from('new lock\n'),
            mode: requiredState(states, 'sync-standards.lock').mode,
            rel: 'sync-standards.lock',
          },
        ],
      });
    } finally {
      process.umask(previousUmask);
    }

    expect(
      lstatSync(join(rootPath, 'existing.txt')).mode % FILE_TYPE_MODE_BASE,
    ).toBe(EXECUTABLE_MODE);
    expect(
      lstatSync(join(rootPath, 'exact-new.txt')).mode % FILE_TYPE_MODE_BASE,
    ).toBe(PUBLIC_MODE);
    expect(
      lstatSync(join(rootPath, 'default-new.txt')).mode % FILE_TYPE_MODE_BASE,
    ).toBe(PRIVATE_MODE);
  });

  for (const operation of ['write', 'fsync', 'close'] as const) {
    it(`cleans every staged file after an injected ${operation} failure`, async () => {
      const rootPath = temporaryRoot();
      writeFixture(rootPath, 'target.txt', 'old\n');
      writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
      const root = await openRepositoryRoot(rootPath, 'consumer');
      const states = await inspectRepositoryFiles(root, [
        'target.txt',
        'sync-standards.lock',
      ]);
      const fault = (candidate: FileOperation, rel: string): Promise<void> =>
        candidate === operation && rel === 'target.txt'
          ? Promise.reject(new Error(`injected ${operation} failure`))
          : Promise.resolve();

      await expect(
        applyRepositoryMutations(
          {
            deletes: [],
            prunes: [],
            root,
            writes: [
              {
                before: requiredState(states, 'target.txt'),
                contents: Buffer.from('new\n'),
                mode: requiredState(states, 'target.txt').mode,
                rel: 'target.txt',
              },
              {
                before: requiredState(states, 'sync-standards.lock'),
                contents: Buffer.from('new lock\n'),
                mode: requiredState(states, 'sync-standards.lock').mode,
                rel: 'sync-standards.lock',
              },
            ],
          },
          { fault },
        ),
      ).rejects.toThrow(`injected ${operation} failure`);

      expect(readFixture(rootPath, 'target.txt')).toBe('old\n');
      expect(readFixture(rootPath, 'sync-standards.lock')).toBe('old lock\n');
      expect(transactionArtifacts(rootPath)).toEqual([]);
    });
  }
});
