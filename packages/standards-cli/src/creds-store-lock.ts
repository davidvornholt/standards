// Broker store lock: a mkdir-based mutex serializing read-modify-write cycles
// on broker.yaml. Each holder records a unique token and its live process.
// Contenders reclaim an expired lock only after that process is dead, and
// cleanup unlinks the exact token before removing the directory. Long
// synchronous SOPS/Nix work therefore cannot look abandoned merely because
// the JavaScript event loop cannot renew a timer.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type HeldBrokerLock,
  reclaimExpiredBrokerLock,
  releaseBrokerLock,
  tryAcquireBrokerLock,
} from './creds-store-lock-holder';

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

// True when the contender may retry immediately. Removing the exact
// generation-specific holder file is the ownership check: if another
// contender already reclaimed it and installed a new token, unlink sees
// ENOENT and can never remove that new holder.
const breakIfStale = async (
  lockPath: string,
  staleMs: number,
): Promise<boolean> => reclaimExpiredBrokerLock(lockPath, staleMs);

// One acquisition attempt: acquired, or cleared a stale/vanished lock (retry
// immediately), or waited one retry slot; a live lock past the deadline
// throws with the remediation hint.
const attemptAcquire = async (
  lockPath: string,
  staleMs: number,
  retryMs: number,
  deadline: number,
): Promise<HeldBrokerLock | null> => {
  const held = await tryAcquireBrokerLock(lockPath);
  if (held !== null) {
    return held;
  }
  if (await breakIfStale(lockPath, staleMs)) {
    return null;
  }
  if (Date.now() >= deadline) {
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
    await releaseBrokerLock(held);
  }
};
