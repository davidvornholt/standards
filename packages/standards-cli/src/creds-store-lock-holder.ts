import { randomUUID } from 'node:crypto';
import { mkdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { startBrokerLockLease } from './creds-store-lock-lease';
import { isRecord } from './github-settings-parse';

const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const HOLDER_PREFIX = 'holder-';
const HOLDER_SUFFIX = '.json';
const LEASE_DIVISOR = 3;

export type HeldBrokerLock = {
  readonly holderPath: string;
  readonly lease: Worker;
  readonly lockPath: string;
};

const isErrorCode = (error: unknown, code: string): boolean =>
  isRecord(error) && error.code === code;

const cleanupCandidate = async (
  candidatePath: string,
  holderPath: string,
): Promise<void> => {
  await unlink(holderPath).catch(() => undefined);
  await rmdir(candidatePath).catch(() => undefined);
};

export const tryAcquireBrokerLock = async (
  lockPath: string,
  staleMs: number,
): Promise<HeldBrokerLock | null> => {
  const generation = randomUUID();
  const candidatePath = `${lockPath}.pending-${generation}`;
  const candidateHolderPath = join(
    candidatePath,
    `${HOLDER_PREFIX}${generation}${HOLDER_SUFFIX}`,
  );
  await mkdir(candidatePath, { mode: OWNER_ONLY_DIR_MODE });
  try {
    await writeFile(candidateHolderPath, JSON.stringify({ generation }), {
      flag: 'wx',
      mode: OWNER_ONLY_FILE_MODE,
    });
    try {
      await rename(candidatePath, lockPath);
    } catch (error) {
      if (isErrorCode(error, 'EEXIST') || isErrorCode(error, 'ENOTEMPTY')) {
        await cleanupCandidate(candidatePath, candidateHolderPath);
        return null;
      }
      throw error;
    }
  } catch (error) {
    await cleanupCandidate(candidatePath, candidateHolderPath);
    throw error;
  }
  const holderPath = join(
    lockPath,
    `${HOLDER_PREFIX}${generation}${HOLDER_SUFFIX}`,
  );
  try {
    const lease = startBrokerLockLease(
      holderPath,
      Math.max(1, Math.floor(staleMs / LEASE_DIVISOR)),
    );
    return { holderPath, lease, lockPath };
  } catch (error) {
    await unlink(holderPath).catch(() => undefined);
    await rmdir(lockPath).catch(() => undefined);
    throw error;
  }
};

export const releaseBrokerLock = async ({
  holderPath,
  lease,
  lockPath,
}: HeldBrokerLock): Promise<void> => {
  await lease.terminate();
  try {
    await unlink(holderPath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  try {
    await rmdir(lockPath);
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
};
