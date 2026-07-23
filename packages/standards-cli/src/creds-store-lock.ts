// Broker store lock: a mkdir-based mutex serializing read-modify-write
// cycles on broker.yaml. Store writes are sub-second, so a lock directory
// older than the staleness window can only belong to a dead process and is
// broken automatically; the timeout error names the directory and the manual
// remediation for the pathological rest.

import { mkdir, rmdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isRecord } from './github-settings-parse';

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

const tryAcquire = async (lockPath: string): Promise<boolean> => {
  try {
    await mkdir(lockPath, { mode: OWNER_ONLY_DIR_MODE });
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
};

// True when the contender may immediately retry: the lock vanished, or it
// was stale and this process removed it (losing the removal race to another
// contender also lands here — the retry's mkdir arbitrates).
const breakIfStale = async (
  lockPath: string,
  staleMs: number,
): Promise<boolean> => {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < staleMs) {
      return false;
    }
    await rmdir(lockPath);
    return true;
  } catch {
    return true;
  }
};

// One acquisition attempt: acquired, or cleared a stale/vanished lock (retry
// immediately), or waited one retry slot; a live lock past the deadline
// throws with the remediation hint.
const attemptAcquire = async (
  lockPath: string,
  staleMs: number,
  retryMs: number,
  deadline: number,
): Promise<boolean> => {
  if (await tryAcquire(lockPath)) {
    return true;
  }
  if (await breakIfStale(lockPath, staleMs)) {
    return false;
  }
  if (Date.now() >= deadline) {
    throw new Error(
      `lock timeout: another creds process holds ${lockPath}; if none is running, remove that directory and retry`,
    );
  }
  await sleep(retryMs);
  return false;
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
  let acquired = false;
  while (!acquired) {
    // biome-ignore lint/performance/noAwaitInLoops: lock acquisition retries are inherently sequential.
    acquired = await attemptAcquire(lockPath, staleMs, retryMs, deadline);
  }
  try {
    return await operation();
  } finally {
    await rmdir(lockPath);
  }
};
