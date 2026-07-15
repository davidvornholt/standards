import { afterEach, expect, it } from 'bun:test';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupFixtures,
  readFixture,
  writeFixture,
} from './sync-mutations-test-helpers';
import {
  attemptProductionSourceSelection,
  attemptSourceSynchronization,
  setupSourceFixture,
} from './sync-source-test-fixture';
import type { SourceSnapshotHooks } from './sync-source-types';

afterEach(cleanupFixtures);

const MANY_SIBLINGS = 128;

it('balances every source descriptor when a later file rejects', async () => {
  const fixture = setupSourceFixture();
  let active = 0;
  const opened: Array<string> = [];
  const closed: Array<string> = [];
  const open = (kind: string, rel: string): Promise<void> => {
    active += 1;
    opened.push(`${kind}:${rel}`);
    return Promise.resolve();
  };
  const close = (kind: string, rel: string): Promise<void> => {
    active -= 1;
    closed.push(`${kind}:${rel}`);
    return Promise.resolve();
  };
  const result = await attemptSourceSynchronization(fixture, {
    hooks: {
      afterDirectoryClose: (rel) => close('directory', rel),
      afterDirectoryOpen: (rel) => open('directory', rel),
      afterFileClose: (rel) => close('file', rel),
      afterFileOpen: (rel) => open('file', rel),
      beforeFileRead: (rel) => {
        if (rel === 'managed/b.txt') {
          throw new Error('second file inspection failed');
        }
        return Promise.resolve();
      },
    },
  });
  expect(result).toMatchObject({
    artifacts: [],
    error: expect.stringContaining('second file inspection failed'),
    lock: 'old lock\n',
    managed: 'consumer\n',
  });
  const sortedOpened = opened.toSorted((left, right) =>
    left.localeCompare(right),
  );
  expect({
    active,
    closed: closed.toSorted((left, right) => left.localeCompare(right)),
    opened: sortedOpened,
  }).toEqual({
    active: 0,
    closed: sortedOpened,
    opened: sortedOpened,
  });
});

it('bounds open source descriptors independently of sibling count', async () => {
  const fixture = setupSourceFixture();
  for (let index = 0; index < MANY_SIBLINGS; index += 1) {
    writeFixture(fixture.source, `managed/file-${index}.txt`, `${index}\n`);
  }
  let current = 0;
  let maximum = 0;
  const opened = (): Promise<void> => {
    current += 1;
    maximum = Math.max(maximum, current);
    return Promise.resolve();
  };
  const closed = (): Promise<void> => {
    current -= 1;
    return Promise.resolve();
  };
  const hooks: SourceSnapshotHooks = {
    afterDirectoryClose: closed,
    afterDirectoryOpen: opened,
    afterFileClose: closed,
    afterFileOpen: opened,
  };
  const result = await attemptSourceSynchronization(fixture, { hooks });
  expect({ current, error: result.error, maximum }).toEqual({
    current: 0,
    error: null,
    maximum: 3,
  });
});

it('rejects directory pathname replacement during final rebinding', async () => {
  const fixture = setupSourceFixture();
  const result = await attemptSourceSynchronization(fixture, {
    hooks: {
      beforeFinalValidation: () => {
        const managed = join(fixture.source, 'managed');
        renameSync(managed, `${managed}.old`);
        mkdirSync(managed);
        writeFixture(fixture.source, 'managed/a.txt', 'old\n');
        writeFixture(fixture.source, 'managed/b.txt', 'sibling\n');
        return Promise.resolve();
      },
    },
  });
  expect(result).toEqual({
    artifacts: [],
    error: expect.stringContaining('Source directory changed'),
    lock: 'old lock\n',
    managed: 'consumer\n',
  });
});

const changeManifest = (
  source: string,
  change: (manifest: { paths: Array<string>; seedDir: string }) => void,
): void => {
  const path = 'sync-standards.json';
  const manifest = JSON.parse(readFixture(source, path)) as {
    paths: Array<string>;
    seedDir: string;
  };
  change(manifest);
  writeFixture(source, path, JSON.stringify(manifest));
};

it('rejects init when manifest paths change before global capture', async () => {
  const fixture = setupSourceFixture(false);
  const result = await attemptProductionSourceSelection(fixture, {
    afterManifestLoad: () => {
      changeManifest(fixture.source, (manifest) => {
        manifest.paths = ['sync-standards.json'];
      });
      return Promise.resolve();
    },
  });
  expect(result).toEqual({
    artifacts: [],
    error: expect.stringContaining('sync-standards.json'),
    lock: null,
    managed: 'consumer\n',
  });
});

it('rejects sync when manifest seedDir changes before global capture', async () => {
  const fixture = setupSourceFixture();
  const result = await attemptProductionSourceSelection(fixture, {
    afterManifestLoad: () => {
      changeManifest(fixture.source, (manifest) => {
        manifest.seedDir = 'other-seed';
      });
      return Promise.resolve();
    },
  });
  expect(result).toEqual({
    artifacts: [],
    error: expect.stringContaining('sync-standards.json'),
    lock: 'old lock\n',
    managed: 'consumer\n',
  });
});
