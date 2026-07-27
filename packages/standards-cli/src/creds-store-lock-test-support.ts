import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each caller keeps its own registry, so one file's afterEach can never remove
// a temporary store another file's still-running test is holding.
export const brokerStorePaths = (
  prefix: string,
): {
  readonly cleanup: () => void;
  readonly mkStorePath: () => string;
} => {
  const dirs: Array<string> = [];
  return {
    cleanup: (): void => {
      for (const dir of dirs.splice(0)) {
        rmSync(dir, { force: true, recursive: true });
      }
    },
    mkStorePath: (): string => {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      return join(dir, 'broker.yaml');
    },
  };
};

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

export const awaitLeaseRefresh = async (path: string): Promise<void> => {
  const file = holderFile(path);
  const acquired = statSync(file).mtimeMs;
  const deadline = Date.now() + LEASE_REFRESH_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    // Only the first poll runs inside this executor. Every later one arrives
    // from a timer, where a throw escapes uncaught instead of rejecting. The
    // runner attributes that to whichever test is running, which is the right
    // one only until the awaiting test times out first — after that the error
    // lands on an innocent neighbour. Rejecting keeps the failure attached to
    // the test that caused it whatever the runner is doing.
    const poll = (): void => {
      try {
        if (statSync(file).mtimeMs !== acquired) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`the lease never refreshed ${file}`));
          return;
        }
        setTimeout(poll, POLL_MS);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    poll();
  });
};
