import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { openRepositoryRoot } from './sync-filesystem';
import {
  cleanupFixtures,
  replaceFixtureFile,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
} from './sync-mutations-test-helpers';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';

const fixture = join(import.meta.dir, 'sync-transaction-crash-fixture.ts');
const transactionName = '.standards-transaction';
const PARENT_BINDING = /^\.standards-parent-binding-/u;
const PRIVATE_MODE = 0o600;
const FILE_TYPE_MODE_BASE = 0o1000;

afterEach(cleanupFixtures);

type BackupOperation = {
  readonly backup: string;
  readonly before: { readonly mode: number | null };
  readonly rel: string;
};

const setup = (phase: string) => {
  const rootPath = temporaryRoot();
  writeFixture(rootPath, 'managed/a.txt', 'old a\n');
  writeFixture(rootPath, 'managed/b.txt', 'old b\n');
  writeFixture(rootPath, 'managed/stale.txt', 'stale\n');
  writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');
  const child = spawnSync(process.execPath, [fixture, rootPath, phase], {
    stdio: 'pipe',
  });
  if (child.signal !== 'SIGKILL') {
    throw new Error(`Crash fixture did not stop at ${phase}`);
  }
  const transactionPath = join(rootPath, transactionName);
  const journal = JSON.parse(
    readFileSync(join(transactionPath, 'journal.json'), 'utf8'),
  ) as { readonly operations: ReadonlyArray<BackupOperation> };
  const operation = journal.operations.find(
    ({ rel }) => rel === 'managed/stale.txt',
  );
  if (operation === undefined) {
    throw new Error('Missing stale-file backup operation');
  }
  return {
    backupPath: join(transactionPath, operation.backup),
    mode: operation.before.mode ?? PRIVATE_MODE,
    rootPath,
    transactionPath,
  };
};

const fileSnapshot = (path: string) => {
  if (!existsSync(path)) {
    return null;
  }
  const info = statSync(path);
  return {
    contents: readFileSync(path).toString('base64'),
    ino: String(info.ino),
    mode: info.mode % FILE_TYPE_MODE_BASE,
  };
};

const stateSnapshot = (rootPath: string, transactionPath: string) => ({
  target: fileSnapshot(join(rootPath, 'managed/stale.txt')),
  transaction: readdirSync(transactionPath)
    .sort()
    .map((name) => ({
      name,
      state: fileSnapshot(join(transactionPath, name)),
    })),
});

const damageBackup = (
  kind: 'corrupt' | 'truncated' | 'wrong-inode',
  backupPath: string,
  mode: number,
): void => {
  if (kind === 'corrupt') {
    writeFileSync(backupPath, 'corrupt backup\n');
    return;
  }
  if (kind === 'truncated') {
    truncateSync(backupPath, 2);
    return;
  }
  replaceFixtureFile(backupPath, 'stale\n', mode);
};

describe('recovery backup integrity', () => {
  for (const [targetState, phase] of [
    ['present', 'after-backup-link'],
    ['absent', 'after-backup-unlink'],
  ] as const) {
    for (const damage of ['corrupt', 'truncated', 'wrong-inode'] as const) {
      it(`preserves a ${damage} backup with its target ${targetState}`, async () => {
        const { backupPath, mode, rootPath, transactionPath } = setup(phase);
        damageBackup(damage, backupPath, mode);
        const before = stateSnapshot(rootPath, transactionPath);
        const root = await openRepositoryRoot(rootPath, 'consumer');

        await expect(recoverRepositoryTransactions(root)).rejects.toThrow(
          `Filesystem recovery retained ${transactionName}`,
        );

        expect(stateSnapshot(rootPath, transactionPath)).toEqual(before);
        expect(transactionArtifacts(rootPath)).toEqual([
          expect.stringMatching(PARENT_BINDING),
          transactionName,
        ]);
      });
    }
  }
});
