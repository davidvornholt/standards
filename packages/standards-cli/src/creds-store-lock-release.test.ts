import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBrokerLock } from './creds-store-lock';

// Release semantics, decided without the clock. The live-lock tests next door
// need wall time because they exercise staleness; what a release does when it
// finds someone else's generation is a pure question, so it is settled here.
const SCALED = { retryMs: 20, staleMs: 500, timeoutMs: 5000 };
const dirs: Array<string> = [];

const mkStorePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-lock-release-'));
  dirs.push(dir);
  return join(dir, 'broker.yaml');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('broker store lock release', () => {
  // The production race this stands in for: unlinking the holder token leaves
  // the lock directory empty for a moment, and renaming onto an empty
  // directory succeeds, so a waiter can publish its generation into exactly
  // that gap. Release runs from a finally, so failing here would report a
  // credential write that already succeeded as an error.
  it('succeeds when a replacement generation appears before release', async () => {
    const path = mkStorePath();
    const lock = `${path}.lock`;
    const replacement = join(lock, 'holder-replacement.json');

    expect(
      await withBrokerLock(
        path,
        () => {
          writeFileSync(
            replacement,
            JSON.stringify({ generation: 'replacement' }),
          );
          return Promise.resolve('wrote the store');
        },
        SCALED,
      ),
    ).toBe('wrote the store');
    expect(readdirSync(lock)).toEqual(['holder-replacement.json']);
  });
});
