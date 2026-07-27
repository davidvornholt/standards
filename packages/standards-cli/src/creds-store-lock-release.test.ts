import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { withBrokerLock } from './creds-store-lock';
import { brokerStorePaths } from './creds-store-lock-test-support';

// What release does when the lock directory is no longer its own to remove,
// decided without the clock. Keeping it out of the live-lock file next door is
// what holds both under the 200-line limit; none of that file's wall time buys
// anything here.
const SCALED = { retryMs: 20, staleMs: 500, timeoutMs: 5000 };
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

  // Tolerating the two handover codes must not become tolerating everything.
  // Replacing the lock directory with a symlink to itself lets the unlink pass
  // through while the rmdir fails with ENOTDIR, which says the lock is still
  // there and still this owner's, so it must surface. Permissions would be the
  // obvious way to force this, but root ignores them and CI can be root.
  it('propagates a removal failure that is not a handover', async () => {
    const path = mkStorePath();
    const lock = `${path}.lock`;
    const attempt = withBrokerLock(
      path,
      () => {
        renameSync(lock, `${lock}.real`);
        symlinkSync(`${lock}.real`, lock);
        return Promise.resolve();
      },
      SCALED,
    );

    const error = await attempt.then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toMatchObject({ code: 'ENOTDIR', syscall: 'rmdir' });
    expect(existsSync(`${lock}.real`)).toBe(true);
  });
});
