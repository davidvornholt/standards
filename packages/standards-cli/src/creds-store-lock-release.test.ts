import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { withBrokerLock } from './creds-store-lock';
import { brokerStorePaths } from './creds-store-lock-test-support';

// What release does when the lock directory is no longer its own to remove,
// decided without the clock. The live-lock file next door reaches 200 lines on
// staleness behaviour alone, and none of that wall time is needed here.
const SCALED = { retryMs: 20, staleMs: 500, timeoutMs: 5000 };
const READ_ONLY_DIR_MODE = 0o500;
const OWNER_ONLY_DIR_MODE = 0o700;
const NOT_PERMITTED = /EACCES|EPERM/u;
const { cleanup, mkStorePath } = brokerStorePaths('creds-lock-release-');

afterEach(cleanup);

describe('broker store lock release', () => {
  // The production race: unlinking the holder token leaves the lock directory
  // empty for a moment, and renaming onto an empty directory succeeds, so a
  // waiter can publish its generation into exactly that gap. Release runs from
  // a finally, so failing here would report a credential write that already
  // succeeded as an error.
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

  it('does not remove a replacement lock generation during release', async () => {
    const path = mkStorePath();
    const lock = `${path}.lock`;
    const replacement = join(lock, 'holder-replacement.json');
    await withBrokerLock(
      path,
      () => {
        const [ownHolder] = readdirSync(lock);
        if (ownHolder === undefined) {
          throw new Error('expected holder token');
        }
        unlinkSync(join(lock, ownHolder));
        rmdirSync(lock);
        mkdirSync(lock);
        writeFileSync(
          replacement,
          JSON.stringify({ generation: 'replacement' }),
        );
        return Promise.resolve();
      },
      SCALED,
    );

    expect(readdirSync(lock)).toEqual(['holder-replacement.json']);
  });

  // Tolerating the two handover codes must not become tolerating everything: a
  // read-only parent directory makes the release rmdir fail with EACCES, which
  // says the lock is still there and still this owner's, and must surface.
  it('propagates a removal failure that is not a handover', async () => {
    const path = mkStorePath();
    const parent = dirname(path);
    const attempt = withBrokerLock(
      path,
      () => {
        chmodSync(parent, READ_ONLY_DIR_MODE);
        return Promise.resolve();
      },
      SCALED,
    );

    try {
      await expect(attempt).rejects.toThrow(NOT_PERMITTED);
    } finally {
      // Restore before afterEach, which cannot delete through a read-only
      // parent — a failed assertion would otherwise break cleanup as well.
      chmodSync(parent, OWNER_ONLY_DIR_MODE);
    }
  });
});
