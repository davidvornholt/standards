import { afterEach, expect, it, spyOn } from 'bun:test';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
// biome-ignore lint/performance/noNamespaceImport: spyOn needs the filesystem module to inject a real unlink between observations.
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
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

it.each(['stat', 'readFile'] as const)(
  'retries when the holder disappears before %s',
  async (boundary) => {
    const lock = `${mkStorePath()}.lock`;
    mkdirSync(lock);
    const holder = join(lock, 'holder-owned.json');
    writeFileSync(holder, JSON.stringify({ generation: 'owned' }));
    const original = boundary === 'stat' ? fs.stat : fs.readFile;
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
