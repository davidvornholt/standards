import { afterEach, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { inspectRepositoryFiles } from './sync-file-inspection';
import { openRepositoryRoot } from './sync-filesystem';
import { applyRepositoryMutations } from './sync-mutations';
import {
  cleanupFixtures,
  requiredState,
  temporaryRoot,
  transactionArtifacts,
  writeFixture,
} from './sync-mutations-test-helpers';
import { TRANSACTION_DIRECTORY } from './sync-transaction-types';

const crossDeviceFixture = join(
  import.meta.dir,
  'sync-transaction-cross-device-fixture.ts',
);
const pruneMountFixture = join(
  import.meta.dir,
  'sync-transaction-prune-mount-fixture.ts',
);
const namespaceProbe = spawnSync('unshare', [
  '-Urnm',
  'sh',
  '-c',
  'set -eu; directory="$(mktemp -d)"; trap \'umount "$directory/target" 2>/dev/null || true; rm -rf "$directory"\' EXIT; touch "$directory/target"; mount --bind /proc/version "$directory/target"; umount "$directory/target"',
]);
const namespaceUnavailable =
  namespaceProbe.status === 0
    ? ''
    : namespaceProbe.stderr.toString().trim() || 'unshare or bind mount failed';

afterEach(cleanupFixtures);

it('rejects a cross-device nearest parent before transaction setup', async () => {
  const root = await openRepositoryRoot('/', 'filesystem root');
  const rel = 'proc/standards-sync-missing';
  const states = await inspectRepositoryFiles(root, [
    rel,
    'sync-standards.lock',
  ]);
  const transactionExisted = existsSync(`/${TRANSACTION_DIRECTORY}`);

  await expect(
    applyRepositoryMutations({
      deletes: [],
      prunes: [],
      root,
      writes: [
        {
          before: requiredState(states, rel),
          contents: Buffer.from('must not write\n'),
          mode: requiredState(states, rel).mode,
          rel,
        },
        {
          before: requiredState(states, 'sync-standards.lock'),
          contents: Buffer.from('must not write lock\n'),
          mode: requiredState(states, 'sync-standards.lock').mode,
          rel: 'sync-standards.lock',
        },
      ],
    }),
  ).rejects.toThrow(
    'Transaction target crosses a filesystem boundary at parent: proc',
  );
  expect(existsSync(`/${TRANSACTION_DIRECTORY}`)).toBe(transactionExisted);
});

if (namespaceUnavailable === '') {
  const runMountFixture = (mode: 'dual-mount' | 'same-device-file') => {
    const rootPath = temporaryRoot();
    writeFixture(rootPath, 'managed/a.txt', 'host file\n');
    writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');

    const result = spawnSync(
      'unshare',
      ['-Urnm', process.execPath, crossDeviceFixture, rootPath, mode],
      { timeout: 10_000 },
    );

    return { result, rootPath };
  };

  it('rejects a same-device bind-mounted file before journal publication', () => {
    const { result, rootPath } = runMountFixture('same-device-file');
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toBe('');
    expect(transactionArtifacts(rootPath)).toEqual([]);
  });

  it('inspects both parent and target mount identities before publication', () => {
    const { result, rootPath } = runMountFixture('dual-mount');
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toBe('');
    expect(transactionArtifacts(rootPath)).toEqual([]);
  });

  it('preserves an unmanaged nested mount while pruning managed parents', () => {
    const rootPath = temporaryRoot();
    writeFixture(rootPath, 'legacy/nested/old.txt', 'retired\n');
    writeFixture(rootPath, 'sync-standards.lock', 'old lock\n');

    const result = spawnSync('unshare', [
      '-Urnm',
      process.execPath,
      pruneMountFixture,
      rootPath,
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toBe('');
    expect(existsSync(join(rootPath, 'legacy/unmanaged-mounted'))).toBe(true);
    expect(existsSync(join(rootPath, 'legacy/nested'))).toBe(false);
  });
} else {
  // biome-ignore lint/suspicious/noSkippedTests: bind mounts require user namespaces; the skipped test name records the probe failure
  it.skip(`bind-mounted preflight unavailable: ${namespaceUnavailable}`, () => {
    expect(namespaceUnavailable).not.toBe('');
  });
}
