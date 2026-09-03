import { utimes } from 'node:fs/promises';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads';

type LeaseWorkerData = {
  readonly holderPath: string;
  readonly intervalMs: number;
};

if (!isMainThread) {
  const { holderPath, intervalMs } = workerData as LeaseWorkerData;
  const timer = setInterval(
    () => utimes(holderPath, new Date(), new Date()).catch(() => undefined),
    intervalMs,
  );
  parentPort?.on('close', () => clearInterval(timer));
}

export const startBrokerLockLease = (
  holderPath: string,
  intervalMs: number,
): Worker => {
  const lease = new Worker(new URL(import.meta.url), {
    workerData: { holderPath, intervalMs } satisfies LeaseWorkerData,
  });
  lease.unref();
  return lease;
};
