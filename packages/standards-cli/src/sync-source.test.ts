import { afterEach, expect, it } from 'bun:test';
import {
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  cleanupFixtures,
  replaceFixtureFile,
  writeFixture,
} from './sync-mutations-test-helpers';
import {
  attemptSourceSynchronization,
  setupSourceFixture,
} from './sync-source-test-fixture';

const RESTORED_TIME_SECONDS = 1_700_000_000;

afterEach(cleanupFixtures);

it('rejects a same-length rewrite even when mtime is restored', async () => {
  const fixture = setupSourceFixture();
  const path = join(fixture.source, 'managed/a.txt');
  utimesSync(path, RESTORED_TIME_SECONDS, RESTORED_TIME_SECONDS);
  const before = statSync(path, { bigint: true });
  const result = await attemptSourceSynchronization(fixture, {
    hooks: {
      beforeFileRead: (rel) => {
        if (rel === 'managed/a.txt') {
          writeFileSync(path, 'new\n');
          utimesSync(path, RESTORED_TIME_SECONDS, RESTORED_TIME_SECONDS);
        }
        return Promise.resolve();
      },
    },
  });
  const after = statSync(path, { bigint: true });
  expect(after.mtimeNs).toBe(before.mtimeNs);
  expect(after.ctimeNs).not.toBe(before.ctimeNs);
  expect(result).toEqual({
    artifacts: [],
    error: expect.stringContaining('Source'),
    lock: 'old lock\n',
    managed: 'consumer\n',
  });
});

it('rejects pathname replacement after a file was read', async () => {
  const fixture = setupSourceFixture();
  const result = await attemptSourceSynchronization(fixture, {
    hooks: {
      beforeFinalValidation: () => {
        replaceFixtureFile(join(fixture.source, 'managed/a.txt'), 'old\n');
        return Promise.resolve();
      },
    },
  });
  expect(result.error).toContain('Source');
  expect(result.managed).toBe('consumer\n');
});

it.each([
  ['addition', (root: string) => writeFixture(root, 'managed/new.txt', 'x')],
  ['removal', (root: string) => rmSync(join(root, 'managed/b.txt'))],
  [
    'rename',
    (root: string) =>
      renameSync(join(root, 'managed/b.txt'), join(root, 'managed/c.txt')),
  ],
])('rejects directory entry %s after traversal', async (_name, mutate) => {
  const fixture = setupSourceFixture();
  const result = await attemptSourceSynchronization(fixture, {
    hooks: {
      beforeFinalValidation: () => Promise.resolve(mutate(fixture.source)),
    },
  });
  expect(result.error).toContain('Source');
  expect(result.managed).toBe('consumer\n');
});

it('revalidates an earlier tree after the other tree reads', async () => {
  const fixture = setupSourceFixture();
  let releaseManagedRead: (() => void) | undefined;
  const managedRead = new Promise<void>((resolve) => {
    releaseManagedRead = resolve;
  });
  const result = await attemptSourceSynchronization(fixture, {
    hooks: {
      afterFileRead: (rel) => {
        if (rel === 'managed/a.txt') {
          releaseManagedRead?.();
        }
        return Promise.resolve();
      },
      beforeFileRead: async (rel) => {
        if (rel === 'seed/seed.txt') {
          await managedRead;
          writeFileSync(join(fixture.source, 'managed/a.txt'), 'new\n');
        }
      },
    },
  });
  expect(result.error).toContain('Source');
  expect(result.managed).toBe('consumer\n');
});
