import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { withBrokerLock } from './creds-store-lock';

const STALE_MS = 10;
const BLOCKED_MAIN_THREAD_MS = 50;
const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('broker store lock lease', () => {
  it('renews while synchronous work blocks the main thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'creds-lock-lease-'));
    dirs.push(dir);
    const path = join(dir, 'broker.yaml');
    await withBrokerLock(
      path,
      () => {
        const [holder] = readdirSync(`${path}.lock`);
        if (holder === undefined) {
          throw new Error('expected holder token');
        }
        const holderPath = join(`${path}.lock`, holder);
        const before = statSync(holderPath).mtimeMs;
        const blocked = spawnSync(process.execPath, [
          '-e',
          `setTimeout(() => undefined, ${BLOCKED_MAIN_THREAD_MS})`,
        ]);
        expect(blocked.status).toBe(0);
        expect(statSync(holderPath).mtimeMs).toBeGreaterThan(before);
        return Promise.resolve();
      },
      { staleMs: STALE_MS },
    );
  });
});
