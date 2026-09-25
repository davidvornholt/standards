import { readdir, readFile, rmdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './github-settings-parse';

const HOLDER_PREFIX = 'holder-';
const HOLDER_SUFFIX = '.json';

export type BrokerLockAvailability = 'blocked' | 'live' | 'retry';

const isErrorCode = (error: unknown, code: string): boolean =>
  isRecord(error) && error.code === code;

type ExistingGeneration =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unknown' }
  | {
      readonly entryPath: string | null;
      readonly kind: 'incomplete';
      readonly modifiedAt: number;
    }
  | {
      readonly entryPath: string;
      readonly kind: 'valid';
      readonly modifiedAt: number;
    };

const missingOr = (
  error: unknown,
  fallback: ExistingGeneration,
): ExistingGeneration =>
  isErrorCode(error, 'ENOENT') ? { kind: 'missing' } : fallback;

const readExistingGeneration = async (
  lockPath: string,
): Promise<ExistingGeneration> => {
  let names: ReadonlyArray<string>;
  try {
    names = await readdir(lockPath);
  } catch (error) {
    return missingOr(error, { kind: 'unknown' });
  }
  if (names.length === 0) {
    // Empty directories are immediately replaceable by an initialized
    // candidate's atomic rename, including the holder-unlink release gap.
    return { kind: 'missing' };
  }
  const entryName = names.length === 1 ? names[0] : undefined;
  if (entryName === undefined) {
    return { kind: 'unknown' };
  }
  const entryPath = join(lockPath, entryName);
  let modifiedAt: number;
  try {
    modifiedAt = (await stat(entryPath)).mtimeMs;
  } catch (error) {
    return missingOr(error, { kind: 'unknown' });
  }
  const incomplete = {
    entryPath,
    kind: 'incomplete' as const,
    modifiedAt,
  };
  if (
    !(entryName.startsWith(HOLDER_PREFIX) && entryName.endsWith(HOLDER_SUFFIX))
  ) {
    return incomplete;
  }
  try {
    const decoded: unknown = JSON.parse(await readFile(entryPath, 'utf8'));
    const generation = entryName.slice(
      HOLDER_PREFIX.length,
      -HOLDER_SUFFIX.length,
    );
    return isRecord(decoded) && decoded.generation === generation
      ? { entryPath, kind: 'valid', modifiedAt }
      : incomplete;
  } catch (error) {
    return missingOr(error, incomplete);
  }
};

const removeObservedGeneration = async (
  lockPath: string,
  entryPath: string | null,
): Promise<boolean> => {
  if (entryPath !== null) {
    try {
      await unlink(entryPath);
    } catch (error) {
      return isErrorCode(error, 'ENOENT');
    }
  }
  try {
    await rmdir(lockPath);
    return true;
  } catch (error) {
    return isErrorCode(error, 'ENOENT');
  }
};

export const inspectBrokerLock = async (
  lockPath: string,
  staleMs: number,
): Promise<BrokerLockAvailability> => {
  const generation = await readExistingGeneration(lockPath);
  if (generation.kind === 'missing') {
    return 'retry';
  }
  if (generation.kind === 'unknown') {
    return 'blocked';
  }
  if (Date.now() - generation.modifiedAt < staleMs) {
    return generation.kind === 'valid' ? 'live' : 'blocked';
  }
  return (await removeObservedGeneration(lockPath, generation.entryPath))
    ? 'retry'
    : 'blocked';
};
