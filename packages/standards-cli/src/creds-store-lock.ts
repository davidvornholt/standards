// Broker store lock: a fully initialized generation is atomically renamed into
// place before its operation starts. A worker-thread lease remains live while
// synchronous SOPS/Nix blocks the main event loop. Cleanup unlinks the exact
// generation token before removing the directory, so an old owner cannot
// remove a replacement — and finding one there instead of an empty directory
// is a no-op, never a failure of the operation being unwound.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import {
  type HeldBrokerLock,
  releaseBrokerLock,
  tryAcquireBrokerLock,
} from './creds-store-lock-holder';
import { inspectBrokerLock } from './creds-store-lock-inspection';

const OWNER_ONLY_DIR_MODE = 0o700;

export type BrokerLockOptions = {
  readonly retryMs?: number;
  readonly timeoutMs?: number;
  readonly staleMs?: number;
};

const DEFAULT_RETRY_MS = 25;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// One acquisition attempt: acquired, or cleared a stale/vanished lock (retry
// immediately), or waited one retry slot. Proven-live generations do not
// consume the recovery deadline; incomplete or ambiguous generations do.
const attemptAcquire = async (
  lockPath: string,
  staleMs: number,
  retryMs: number,
  deadline: number,
): Promise<HeldBrokerLock | null> => {
  const held = await tryAcquireBrokerLock(lockPath, staleMs);
  if (held !== null) {
    return held;
  }
  const availability = await inspectBrokerLock(lockPath, staleMs);
  if (availability === 'retry') {
    return null;
  }
  if (availability === 'blocked' && Date.now() >= deadline) {
    throw new Error(
      `lock timeout: another creds process holds ${lockPath}; if none is running, remove that directory and retry`,
    );
  }
  await sleep(retryMs);
  return null;
};

export const withBrokerLock = async <T>(
  path: string,
  operation: () => Promise<T>,
  options: BrokerLockOptions = {},
): Promise<T> => {
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  const deadline = Date.now() + timeoutMs;
  let held: HeldBrokerLock | null = null;
  while (held === null) {
    // biome-ignore lint/performance/noAwaitInLoops: lock acquisition retries are inherently sequential.
    held = await attemptAcquire(lockPath, staleMs, retryMs, deadline);
  }
  try {
    return await operation();
  } finally {
    try {
      await releaseBrokerLock(held);
    } catch (error) {
      // Cleanup must preserve either the durable operation result or its
      // original failure. The stopped lease makes abandoned holders stale.
      try {
        process.stderr.write(
          `standards creds: warning: lock cleanup failed for ${lockPath}: ${error instanceof Error ? error.message : String(error)}; the operation result is unchanged; retry after the stale-lock window\n`,
        );
      } catch {
        // Even an unavailable diagnostic stream cannot change that result.
      }
    }
  }
};
