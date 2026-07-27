import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withBrokerLock } from './creds-store-lock';
import {
  awaitLeaseRefresh,
  brokerStorePaths,
} from './creds-store-lock-test-support';

// The staleness window is scaled down from the 30s default so these tests run
// in seconds, but not below what a loaded machine can actually honour. The
// holder keeps its lock alive from a worker thread that refreshes every
// staleMs/3, so a window narrow enough for one missed scheduling slot to span
// it makes a live holder look abandoned and the test assert against the
// scheduler rather than against the lock.
const SCALED_STALE_MS = 500;
const LIVE_WAIT_MULTIPLIER = 4;
// Bun's default is 5s, and the fixed sleeps below spend 2s of it before the
// lease wait is counted. That leaves too little for worker startup on a loaded
// runner, and it is less than awaitLeaseRefresh's own 10s budget, so its
// diagnostic could never print: a timing failure would report as a bare
// timeout instead of naming the lease that never refreshed.
const TEST_TIMEOUT_MS = 20_000;
const SCALED = {
  timeoutMs: 5000,
  retryMs: 20,
  staleMs: SCALED_STALE_MS,
};
const { cleanup, mkStorePath } = brokerStorePaths('creds-lock-live-');

afterEach(cleanup);

describe('broker store live-lock serialization', () => {
  it(
    'keeps delayed SOPS, same-owner replacement, and another contender exclusive past staleness',
    async () => {
      const path = mkStorePath();
      const events: Array<string> = [];
      let active = 0;
      let maximumActive = 0;
      let releaseSops = (): void => undefined;
      let markSopsStarted = (): void => undefined;
      const sopsStarted = new Promise<void>((resolve) => {
        markSopsStarted = resolve;
      });
      const sopsRelease = new Promise<void>((resolve) => {
        releaseSops = resolve;
      });
      const operation = (
        name: string,
        wait: Promise<void> | null = null,
      ): Promise<void> =>
        withBrokerLock(
          path,
          async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            events.push(`${name}-start`);
            if (name === 'sops') {
              markSopsStarted();
            }
            if (wait !== null) {
              await wait;
            }
            events.push(`${name}-end`);
            active -= 1;
          },
          SCALED,
        );
      const sops = operation('sops', sopsRelease);
      await sopsStarted;
      await awaitLeaseRefresh(path);
      await new Promise((resolve) => setTimeout(resolve, SCALED_STALE_MS * 2));
      const replacement = operation('same-owner-replacement');
      const contender = operation('other-contender');
      await new Promise((resolve) => setTimeout(resolve, SCALED_STALE_MS * 2));

      expect(events).toEqual(['sops-start']);
      expect(maximumActive).toBe(1);
      releaseSops();
      await Promise.all([sops, replacement, contender]);

      expect(maximumActive).toBe(1);
      expect(events.slice(0, 2)).toEqual(['sops-start', 'sops-end']);
      expect(new Set(events.slice(2))).toEqual(
        new Set([
          'same-owner-replacement-start',
          'same-owner-replacement-end',
          'other-contender-start',
          'other-contender-end',
        ]),
      );
      expect(existsSync(`${path}.lock`)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('broker store lock generation lifecycle', () => {
  it(
    'waits past the recovery timeout while a generation lease remains live',
    async () => {
      const path = mkStorePath();
      let releaseHolder = (): void => undefined;
      let markStarted = (): void => undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const holder = withBrokerLock(
        path,
        async () => {
          markStarted();
          await release;
        },
        SCALED,
      );
      await started;
      await awaitLeaseRefresh(path);
      let contenderRan = false;
      const contender = withBrokerLock(
        path,
        () => {
          contenderRan = true;
          return Promise.resolve();
        },
        { ...SCALED, timeoutMs: SCALED_STALE_MS },
      );
      await new Promise((resolve) =>
        setTimeout(resolve, SCALED_STALE_MS * LIVE_WAIT_MULTIPLIER),
      );

      expect(contenderRan).toBe(false);
      releaseHolder();
      await Promise.all([holder, contender]);
      expect(contenderRan).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it('ignores an incomplete private candidate left before publication', async () => {
    const path = mkStorePath();
    const candidate = `${path}.lock.pending-crashed`;
    mkdirSync(candidate);
    writeFileSync(join(candidate, 'holder-crashed.json'), '{"generation":');

    expect(
      await withBrokerLock(path, () => Promise.resolve('ran'), SCALED),
    ).toBe('ran');
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(existsSync(candidate)).toBe(true);
  });
});
