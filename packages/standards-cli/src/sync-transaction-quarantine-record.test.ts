import { afterEach, describe, expect, it } from 'bun:test';
import {
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { openPinnedRoot } from './sync-directory-handles';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  temporaryRoot,
  writeFixture,
} from './sync-mutations-test-helpers';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';
import { publishQuarantineRecord } from './sync-transaction-quarantine-publication';
import { readQuarantineRecords } from './sync-transaction-quarantine-record';
import {
  MAX_QUARANTINE_RECORD_BYTES,
  quarantineRecordContents,
  quarantineToken,
} from './sync-transaction-quarantine-schema';

afterEach(cleanupFixtures);

const NAME_MAX = 255;
const SHA256_LENGTH = 64;
const QUARANTINE_ARTIFACT_COUNT = 4;

const pinnedRoot = async () => {
  const rootPath = temporaryRoot();
  const root = await openRepositoryRoot(rootPath, 'consumer');
  return { directory: await openPinnedRoot(root), rootPath };
};

describe('quarantine ownership records', () => {
  it('uses fixed NAME_MAX-safe artifacts for a maximum-length name', async () => {
    const { directory, rootPath } = await pinnedRoot();
    const name = 'x'.repeat(NAME_MAX);
    writeFixture(rootPath, name, 'owned\n');
    const info = statSync(join(rootPath, name), { bigint: true });
    try {
      await bindAndRemoveEntry({
        directory,
        expected: { dev: info.dev, ino: info.ino },
        kind: 'file',
        name,
      });
      const artifacts = readdirSync(rootPath).filter((entry) =>
        entry.startsWith('.standards-removal-'),
      );
      expect(artifacts).toHaveLength(QUARANTINE_ARTIFACT_COUNT);
      expect(
        artifacts.every((entry) => Buffer.byteLength(entry) <= NAME_MAX),
      ).toBe(true);
      expect((await readQuarantineRecords(directory))[0]?.original).toBe(name);
    } finally {
      await directory.handle.close();
    }
  });

  it('rejects overlong names before publication and fails closed on metadata replacement', async () => {
    const { directory, rootPath } = await pinnedRoot();
    writeFixture(rootPath, 'owned', 'owned\n');
    const info = statSync(join(rootPath, 'owned'), { bigint: true });
    try {
      await expect(
        bindAndRemoveEntry({
          directory,
          expected: { dev: info.dev, ino: info.ino },
          kind: 'file',
          name: 'x'.repeat(NAME_MAX + 1),
        }),
      ).rejects.toThrow('original name is invalid');
      expect(
        readdirSync(rootPath).some((entry) =>
          entry.startsWith('.standards-removal-'),
        ),
      ).toBe(false);
      await bindAndRemoveEntry({
        directory,
        expected: { dev: info.dev, ino: info.ino },
        kind: 'file',
        name: 'owned',
      });
      const record = readdirSync(rootPath).find((entry) =>
        entry.endsWith('.json'),
      );
      if (record === undefined) {
        throw new Error('Missing quarantine record');
      }
      renameSync(join(rootPath, record), join(rootPath, 'actor-record'));
      writeFileSync(join(rootPath, record), '{}\n');
      await expect(readQuarantineRecords(directory)).rejects.toThrow(
        'publication changed',
      );
    } finally {
      await directory.handle.close();
    }
  });
});

describe('quarantine publication bounds', () => {
  it('round-trips a worst-case escaped NAME_MAX original within the cap', async () => {
    const { directory, rootPath } = await pinnedRoot();
    const name = '\u0001'.repeat(NAME_MAX);
    writeFixture(rootPath, name, 'owned\n');
    const info = statSync(join(rootPath, name), { bigint: true });
    try {
      await bindAndRemoveEntry({
        directory,
        expected: { dev: info.dev, ino: info.ino },
        kind: 'file',
        name,
      });
      const [record] = await readQuarantineRecords(directory);
      expect(record?.original).toBe(name);
      if (record === undefined) {
        throw new Error('Missing quarantine record');
      }
      expect(
        Buffer.byteLength(quarantineRecordContents(record)),
      ).toBeLessThanOrEqual(MAX_QUARANTINE_RECORD_BYTES);
    } finally {
      await directory.handle.close();
    }
  });

  it('rejects a record larger than the computed maximum', async () => {
    const { directory, rootPath } = await pinnedRoot();
    const token = 'a'.repeat(SHA256_LENGTH);
    writeFixture(
      rootPath,
      `.standards-removal-${token}.tail`,
      'x'.repeat(MAX_QUARANTINE_RECORD_BYTES + 1),
    );
    try {
      await expect(readQuarantineRecords(directory)).rejects.toThrow(
        'small regular file',
      );
    } finally {
      await directory.handle.close();
    }
  });

  it('rejects a same-content replacement of the published tail pathname', async () => {
    const { directory, rootPath } = await pinnedRoot();
    writeFixture(rootPath, 'owned', 'owned\n');
    const info = statSync(join(rootPath, 'owned'), { bigint: true });
    const identity = { dev: info.dev, ino: info.ino };
    const tail = `.standards-removal-${quarantineToken('owned', identity, 'file')}.tail`;
    try {
      await expect(
        publishQuarantineRecord({
          directory,
          hooks: {
            afterTailSync: () => {
              const contents = readFileSync(join(rootPath, tail));
              renameSync(join(rootPath, tail), join(rootPath, 'actor-tail'));
              writeFileSync(join(rootPath, tail), contents);
              return Promise.resolve();
            },
          },
          identity,
          kind: 'file',
          original: 'owned',
        }),
      ).rejects.toThrow('publication changed');
      expect(readFileSync(join(rootPath, tail), 'utf8')).toContain(
        '"original":"owned"',
      );
    } finally {
      await directory.handle.close();
    }
  });
});
