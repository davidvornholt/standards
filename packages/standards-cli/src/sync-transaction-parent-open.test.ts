import { afterEach, expect, it } from 'bun:test';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  closePinnedDirectories,
  openPinnedRoot,
  type PinnedDirectory,
} from './sync-directory-handles';
import type { NodeIdentity } from './sync-filesystem';
import { openRepositoryRoot } from './sync-filesystem';
import { cleanupFixtures, temporaryRoot } from './sync-mutations-test-helpers';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';
import { openCreatedParent } from './sync-transaction-parent-open';

afterEach(cleanupFixtures);

it('opens the exact retained created-parent generation by durable identity', async () => {
  const rootPath = temporaryRoot();
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const rootDirectory = await openPinnedRoot(root);
  try {
    const retain = async (): Promise<NodeIdentity> => {
      mkdirSync(join(rootPath, 'created'));
      const info = statSync(join(rootPath, 'created'), { bigint: true });
      const identity = { dev: info.dev, ino: info.ino };
      await bindAndRemoveEntry({
        directory: rootDirectory,
        expected: identity,
        kind: 'directory',
        name: 'created',
      });
      return identity;
    };
    const assertGeneration = async (expected: NodeIdentity): Promise<void> => {
      const opened: Array<PinnedDirectory> = [];
      try {
        const result = await openCreatedParent(
          root,
          'created',
          opened,
          expected,
        );
        expect(result.directory?.identity).toEqual(expected);
      } finally {
        await closePinnedDirectories(opened);
      }
    };
    const first = await retain();
    const second = await retain();
    await assertGeneration(first);
    await assertGeneration(second);
  } finally {
    await rootDirectory.handle.close();
  }
});
