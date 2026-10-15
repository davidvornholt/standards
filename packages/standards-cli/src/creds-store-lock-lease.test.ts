import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBrokerLock } from './creds-store-lock';

const STALE_MS = 10;
// The lease worker can take several renewal intervals to start on a loaded
// machine; this only bounds how long a broken lease makes the test wait, and
// stays below the 5 s test timeout so that failure reports the stale holder.
const RENEWAL_DEADLINE_MS = 2000;
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
        // Block the main thread, as synchronous SOPS or Nix work does, until
        // the lease renews the holder or the deadline passes.
        const pause = new Int32Array(
          new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
        );
        const deadline = Date.now() + RENEWAL_DEADLINE_MS;
        while (
          statSync(holderPath).mtimeMs <= before &&
          Date.now() < deadline
        ) {
          Atomics.wait(pause, 0, 0, 1);
        }
        expect(statSync(holderPath).mtimeMs).toBeGreaterThan(before);
        return Promise.resolve();
      },
      { staleMs: STALE_MS },
    );
  });
});
