import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { isRecord } from './github-settings-parse';

const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const HOLDER_PREFIX = 'holder-';
const HOLDER_SUFFIX = '.json';

export type HeldBrokerLock = {
  readonly lockPath: string;
  readonly holderPath: string;
};

const isErrorCode = (error: unknown, code: string): boolean =>
  isRecord(error) && error.code === code;

export const tryAcquireBrokerLock = async (
  lockPath: string,
): Promise<HeldBrokerLock | null> => {
  try {
    await mkdir(lockPath, { mode: OWNER_ONLY_DIR_MODE });
  } catch (error) {
    if (isErrorCode(error, 'EEXIST')) {
      return null;
    }
    throw error;
  }
  const holderPath = join(
    lockPath,
    `${HOLDER_PREFIX}${randomUUID()}${HOLDER_SUFFIX}`,
  );
  try {
    await writeFile(holderPath, JSON.stringify({ pid: process.pid }), {
      flag: 'wx',
      mode: OWNER_ONLY_FILE_MODE,
    });
  } catch (error) {
    await rmdir(lockPath).catch(() => undefined);
    throw error;
  }
  return { lockPath, holderPath };
};

type ExistingHolder = {
  readonly holderPath: string;
  readonly modifiedAt: number;
  readonly pid: number;
};

const readExistingHolder = async (
  lockPath: string,
): Promise<ExistingHolder | 'missing' | 'unknown'> => {
  let names: ReadonlyArray<string>;
  try {
    names = await readdir(lockPath);
  } catch (error) {
    return isErrorCode(error, 'ENOENT') ? 'missing' : 'unknown';
  }
  const holders = names.filter(
    (entry) => entry.startsWith(HOLDER_PREFIX) && entry.endsWith(HOLDER_SUFFIX),
  );
  const holderName = holders.length === 1 ? holders[0] : undefined;
  if (holderName === undefined || names.length !== 1) {
    return 'unknown';
  }
  const holderPath = join(lockPath, holderName);
  try {
    const [raw, info] = await Promise.all([
      readFile(holderPath, 'utf8'),
      stat(holderPath),
    ]);
    const decoded: unknown = JSON.parse(raw);
    return isRecord(decoded) &&
      typeof decoded.pid === 'number' &&
      Number.isInteger(decoded.pid) &&
      decoded.pid > 0
      ? { holderPath, modifiedAt: info.mtimeMs, pid: decoded.pid }
      : 'unknown';
  } catch {
    return 'unknown';
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, 'ESRCH');
  }
};

export const reclaimExpiredBrokerLock = async (
  lockPath: string,
  staleMs: number,
): Promise<boolean> => {
  const holder = await readExistingHolder(lockPath);
  if (holder === 'missing') {
    return true;
  }
  if (
    holder === 'unknown' ||
    Date.now() - holder.modifiedAt < staleMs ||
    isProcessAlive(holder.pid)
  ) {
    return false;
  }
  try {
    await unlink(holder.holderPath);
  } catch (error) {
    return isErrorCode(error, 'ENOENT');
  }
  try {
    await rmdir(lockPath);
    return true;
  } catch (error) {
    return isErrorCode(error, 'ENOENT');
  }
};

export const releaseBrokerLock = async ({
  holderPath,
  lockPath,
}: HeldBrokerLock): Promise<void> => {
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
