import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The lease that keeps a held lock alive runs in a worker thread, and starting
// that thread costs more wall clock on a loaded runner than a scaled staleness
// window. Waiting for the first refresh proves the lease is running before any
// contender is allowed to judge the holder stale, so what the live-lock tests
// exercise is staleness against a live lease rather than a race with worker
// startup.
const LEASE_REFRESH_TIMEOUT_MS = 10_000;
const POLL_MS = 1;

const holderFile = (path: string): string => {
  const lockPath = `${path}.lock`;
  const holder = readdirSync(lockPath).find(
    (entry) => entry.startsWith('holder-') && entry.endsWith('.json'),
  );
  if (holder === undefined) {
    throw new Error(`no holder file under ${lockPath}`);
  }
  return join(lockPath, holder);
};

export const awaitLeaseRefresh = (path: string): Promise<void> => {
  const file = holderFile(path);
  const acquired = statSync(file).mtimeMs;
  const deadline = Date.now() + LEASE_REFRESH_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (statSync(file).mtimeMs !== acquired) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`the lease never refreshed ${file}`));
        return;
      }
      setTimeout(poll, POLL_MS);
    };
    poll();
  });
};
