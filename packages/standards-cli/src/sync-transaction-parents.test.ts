import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import type { FileOperation } from './sync-transaction-types';

afterEach(cleanupFixtures);
const PARENT_BINDING = /^\.standards-parent-binding-/u;

const setup = async () => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const states = await inspectRepositoryFiles(root, [
    'new-parent/new.txt',
    'sync-standards.lock',
  ]);
  return {
    plan: {
      deletes: [],
      prunes: [],
      root,
      writes: [
        {
          before: requiredState(states, 'new-parent/new.txt'),
          contents: Buffer.from('canonical\n'),
          mode: requiredState(states, 'new-parent/new.txt').mode,
          rel: 'new-parent/new.txt',
        },
        {
          before: requiredState(states, 'sync-standards.lock'),
          contents: Buffer.from('new lock\n'),
          mode: requiredState(states, 'sync-standards.lock').mode,
          rel: 'sync-standards.lock',
        },
      ],
    },
    rootPath,
  };
};

describe('created-parent ownership recovery', () => {
  it('removes an inode-bound markerless mkdir after a failure', async () => {
    const { plan, rootPath } = await setup();
    const fault = (operation: FileOperation, rel: string, timing?: string) =>
      operation === 'mkdir' && rel === 'new-parent' && timing === 'after'
        ? Promise.reject(new Error('mkdir window'))
        : Promise.resolve();

    await expect(applyRepositoryMutations(plan, { fault })).rejects.toThrow(
      'mkdir window',
    );

    expect(existsSync(join(rootPath, 'new-parent'))).toBe(false);
    expect(transactionArtifacts(rootPath)).toEqual([]);
  });

  it('preserves a replaced empty markerless directory', async () => {
    const { plan, rootPath } = await setup();
    const fault = (
      operation: FileOperation,
      rel: string,
      timing: 'after' | 'before' = 'after',
    ): Promise<void> => {
      if (operation === 'mkdir' && rel === 'new-parent' && timing === 'after') {
        rmdirSync(join(rootPath, 'new-parent'));
        mkdirSync(join(rootPath, 'new-parent'));
        return Promise.reject(new Error('replaced markerless parent'));
      }
      return Promise.resolve();
    };

    await expect(applyRepositoryMutations(plan, { fault })).rejects.toThrow(
      'recovery journal retained',
    );

    expect(existsSync(join(rootPath, 'new-parent'))).toBe(true);
    expect(transactionArtifacts(rootPath)).toEqual([
      expect.stringMatching(PARENT_BINDING),
      '.standards-transaction',
    ]);
  });

  for (const phase of ['mkdir', 'install'] as const) {
    it(`preserves an actor file after the ${phase} phase`, async () => {
      const { plan, rootPath } = await setup();
      const fault = (
        operation: FileOperation,
        rel: string,
        timing: 'after' | 'before' = 'after',
      ): Promise<void> => {
        const inject =
          (phase === 'mkdir' &&
            operation === 'mkdir' &&
            rel === 'new-parent' &&
            timing === 'after') ||
          (phase === 'install' &&
            operation === 'install' &&
            rel === 'new-parent/new.txt' &&
            timing === 'after');
        if (inject) {
          writeFileSync(join(rootPath, 'new-parent/actor.txt'), 'actor\n');
          return Promise.reject(new Error(`actor after ${phase}`));
        }
        return Promise.resolve();
      };

      await expect(applyRepositoryMutations(plan, { fault })).rejects.toThrow(
        'recovery journal retained',
      );

      expect(readFixture(rootPath, 'new-parent/actor.txt')).toBe('actor\n');
      expect(transactionArtifacts(rootPath)).toEqual([
        expect.stringMatching(PARENT_BINDING),
        '.standards-transaction',
      ]);
    });
  }

  for (const artifact of [
    '.standards-owner-publication-invalid',
    '.standards-parent-binding-invalid',
  ]) {
    it(`rejects occupied ${artifact} namespace before mutation`, async () => {
      const { plan, rootPath } = await setup();
      writeFileSync(join(rootPath, artifact), 'x');

      await expect(applyRepositoryMutations(plan)).rejects.toThrow(
        'namespace is occupied',
      );

      expect(readFixture(rootPath, 'sync-standards.lock')).toBe('old lock\n');
      expect(existsSync(join(rootPath, '.standards-transaction'))).toBe(false);
      expect(transactionArtifacts(rootPath)).toEqual([artifact]);
    });
  }
});
