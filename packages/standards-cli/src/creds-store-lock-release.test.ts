import { afterEach, describe, expect, it, spyOn } from 'bun:test';
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
import process from 'node:process';
import { withBrokerLock } from './creds-store-lock';
import { brokerStorePaths } from './creds-store-lock-test-support';

// Keep release ownership races separate from the clock-dependent live-lock
// cases so failures identify which contract broke.
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

  it.each([false, true])(
    'preserves the operation result when cleanup fails (operation failed: %s)',
    async (fails) => {
      const path = mkStorePath();
      const lock = `${path}.lock`;
      const warning = spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        const result = await withBrokerLock(
          path,
          () => {
            renameSync(lock, `${lock}.real`);
            symlinkSync(`${lock}.real`, lock);
            return fails
              ? Promise.reject(new Error('original write failure'))
              : Promise.resolve('durable credential');
          },
          SCALED,
        ).catch((error: unknown) =>
          error instanceof Error ? error.message : String(error),
        );
        expect(result).toBe(
          fails ? 'original write failure' : 'durable credential',
        );
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining(`lock cleanup failed for ${lock}`),
        );
        expect(existsSync(`${lock}.real`)).toBe(true);
      } finally {
        warning.mockRestore();
      }
    },
  );
});
