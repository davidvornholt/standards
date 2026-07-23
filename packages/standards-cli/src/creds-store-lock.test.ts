import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBrokerLock } from './creds-store-lock';

const MS_PER_SECOND = 1000;
const STALE_AGE_MS = 120_000;
const HOLD_MS = 25;
const FAST = { timeoutMs: 500, retryMs: 5 };

const dirs: Array<string> = [];
const mkStorePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-lock-'));
  dirs.push(dir);
  return join(dir, 'broker.yaml');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('broker store lock', () => {
  it('breaks a stale lock left by a dead process and proceeds', async () => {
    const path = mkStorePath();
    const lock = `${path}.lock`;
    mkdirSync(lock);
    const past = (Date.now() - STALE_AGE_MS) / MS_PER_SECOND;
    await utimes(lock, past, past);
    const result = await withBrokerLock(
      path,
      () => Promise.resolve('ran'),
      FAST,
    );
    expect(result).toBe('ran');
    expect(existsSync(lock)).toBe(false);
  });

  it('times out on a live lock with a remediation hint', async () => {
    const path = mkStorePath();
    mkdirSync(`${path}.lock`);
    await expect(
      withBrokerLock(path, () => Promise.resolve('ran'), {
        ...FAST,
        timeoutMs: 100,
        staleMs: STALE_AGE_MS,
      }),
    ).rejects.toThrow('remove that directory and retry');
    expect(existsSync(`${path}.lock`)).toBe(true);
  });

  it('serializes concurrent operations instead of interleaving them', async () => {
    const path = mkStorePath();
    const order: Array<string> = [];
    const contender = (name: string) => (): Promise<void> =>
      withBrokerLock(
        path,
        async () => {
          order.push(`${name}-start`);
          await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
          order.push(`${name}-end`);
        },
        FAST,
      );
    await Promise.all([contender('a')(), contender('b')()]);
    const first = order[0]?.split('-')[0];
    expect(order).toEqual([
      `${first}-start`,
      `${first}-end`,
      expect.stringContaining('-start'),
      expect.stringContaining('-end'),
    ]);
  });

  it('releases the lock after the operation fails', async () => {
    const path = mkStorePath();
    await expect(
      withBrokerLock(path, () => Promise.reject(new Error('boom')), FAST),
    ).rejects.toThrow('boom');
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});
