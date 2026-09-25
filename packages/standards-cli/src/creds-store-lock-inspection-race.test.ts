import { afterEach, expect, it, spyOn } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
// biome-ignore lint/performance/noNamespaceImport: spyOn needs the filesystem module to inject a real unlink between observations.
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { withBrokerLock } from './creds-store-lock';
import { inspectBrokerLock } from './creds-store-lock-inspection';
import { brokerStorePaths } from './creds-store-lock-test-support';

const { cleanup, mkStorePath } = brokerStorePaths('lock-inspect-race-');
const STALE_MS = 30_000;
afterEach(cleanup);

it('retries a newly emptied release directory without consuming a recovery timeout', async () => {
  const lock = `${mkStorePath()}.lock`;
  mkdirSync(lock);
  expect(await inspectBrokerLock(lock, STALE_MS)).toBe('retry');
});

it.each(['lstat', 'readFile'] as const)(
  'retries when the holder disappears before %s',
  async (boundary) => {
    const lock = `${mkStorePath()}.lock`;
    mkdirSync(lock);
    const holder = join(lock, 'holder-owned.json');
    writeFileSync(holder, JSON.stringify({ generation: 'owned' }));
    const original = boundary === 'lstat' ? fs.lstat : fs.readFile;
    const observe = spyOn(fs, boundary).mockImplementation(
      (...args: Array<unknown>) => {
        unlinkSync(holder);
        return Reflect.apply(original, fs, args);
      },
    );
    try {
      expect(await inspectBrokerLock(lock, STALE_MS)).toBe('retry');
      expect(readdirSync(lock)).toEqual([]);
    } finally {
      observe.mockRestore();
    }
  },
);

it('bounds waiting on a dangling holder symlink without reclaiming it', async () => {
  const path = mkStorePath();
  const lock = `${path}.lock`;
  mkdirSync(lock);
  const holder = join(lock, 'holder-broken.json');
  symlinkSync('missing', holder);
  await expect(
    withBrokerLock(path, () => Promise.resolve(), {
      timeoutMs: 25,
      retryMs: 5,
      staleMs: 1,
    }),
  ).rejects.toThrow('lock timeout');
  expect(lstatSync(holder).isSymbolicLink()).toBe(true);
});

it.each(['EACCES', 'EIO'])(
  'does not reclaim a stale holder whose bytes are unreadable (%s)',
  async (code) => {
    const lock = `${mkStorePath()}.lock`;
    mkdirSync(lock);
    const holder = join(lock, 'holder-owned.json');
    writeFileSync(holder, JSON.stringify({ generation: 'owned' }));
    utimesSync(holder, 0, 0);
    const read = spyOn(fs, 'readFile').mockRejectedValue(
      Object.assign(new Error('unreadable'), { code }),
    );
    try {
      expect(await inspectBrokerLock(lock, STALE_MS)).toBe('blocked');
      expect(readdirSync(lock)).toEqual(['holder-owned.json']);
    } finally {
      read.mockRestore();
    }
  },
);
