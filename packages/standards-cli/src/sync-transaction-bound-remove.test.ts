import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openPinnedRoot } from './sync-directory-handles';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  readFixture,
  temporaryRoot,
  writeFixture,
} from './sync-mutations-test-helpers';
import {
  bindAndRemoveEntry,
  removalBindingName,
} from './sync-transaction-bound-remove';
import {
  createTransactionReservation,
  removeTransactionReservation,
} from './sync-transaction-reservation';
import { TRANSACTION_RESERVATION } from './sync-transaction-types';

afterEach(cleanupFixtures);

const pinnedRoot = async () => {
  const rootPath = temporaryRoot();
  const root = await openRepositoryRoot(rootPath, 'consumer');
  return { directory: await openPinnedRoot(root), rootPath };
};

describe('bound transaction cleanup', () => {
  it('preserves a file replacement installed after atomic binding', async () => {
    const { directory, rootPath } = await pinnedRoot();
    writeFixture(rootPath, 'owned', 'owned\n');
    const info = statSync(join(rootPath, 'owned'), { bigint: true });
    const expected = { dev: info.dev, ino: info.ino };
    try {
      await bindAndRemoveEntry({
        afterBind: () => {
          writeFixture(rootPath, 'owned', 'actor\n');
          return Promise.resolve();
        },
        directory,
        expected,
        kind: 'file',
        name: 'owned',
      });
      expect(readFixture(rootPath, 'owned')).toBe('actor\n');
    } finally {
      await directory.handle.close();
    }
  });

  it('converges after file and directory post-bind crashes', async () => {
    const { directory, rootPath } = await pinnedRoot();
    writeFixture(rootPath, 'owned', 'owned\n');
    mkdirSync(join(rootPath, 'empty'));
    const file = statSync(join(rootPath, 'owned'), { bigint: true });
    const folder = statSync(join(rootPath, 'empty'), { bigint: true });
    try {
      const crashAndRecover = async (
        name: string,
        kind: 'directory' | 'file',
        expected: { readonly dev: bigint; readonly ino: bigint },
      ): Promise<void> => {
        await expect(
          bindAndRemoveEntry({
            afterBind: () => Promise.reject(new Error('crash after bind')),
            directory,
            expected,
            kind,
            name,
          }),
        ).rejects.toThrow('crash after bind');
        await bindAndRemoveEntry({ directory, expected, kind, name });
      };
      await crashAndRecover('owned', 'file', {
        dev: file.dev,
        ino: file.ino,
      });
      await crashAndRecover('empty', 'directory', {
        dev: folder.dev,
        ino: folder.ino,
      });
      expect(() => statSync(join(rootPath, 'owned'))).toThrow();
      expect(() => statSync(join(rootPath, 'empty'))).toThrow();
    } finally {
      await directory.handle.close();
    }
  });

  it('recovers a bound reservation and preserves its public replacement', async () => {
    const { directory, rootPath } = await pinnedRoot();
    const id = '00000000-0000-4000-8000-000000000000';
    try {
      await createTransactionReservation(directory, id);
      const info = statSync(join(rootPath, TRANSACTION_RESERVATION), {
        bigint: true,
      });
      await expect(
        removeTransactionReservation(directory, id, {
          afterBind: () => Promise.reject(new Error('reservation crash')),
        }),
      ).rejects.toThrow('reservation crash');
      writeFixture(rootPath, TRANSACTION_RESERVATION, 'actor\n');
      await expect(removeTransactionReservation(directory, id)).rejects.toThrow(
        'invalid',
      );
      expect(readFixture(rootPath, TRANSACTION_RESERVATION)).toBe('actor\n');
      const actor = join(rootPath, '.actor-reservation');
      renameSync(join(rootPath, TRANSACTION_RESERVATION), actor);
      await removeTransactionReservation(directory, id);
      expect(readFixture(rootPath, '.actor-reservation')).toBe('actor\n');
      expect(
        statSync(
          join(
            rootPath,
            removalBindingName(TRANSACTION_RESERVATION, {
              dev: info.dev,
              ino: info.ino,
            }),
          ),
        ).isFile(),
      ).toBe(true);
    } finally {
      await directory.handle.close();
    }
  });
});
