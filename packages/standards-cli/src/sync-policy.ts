import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isContainedPath } from './contained-path';
import { isNonEmptyString, isRecord } from './github-settings-parse';

export const SYNC_POLICY_FILE = 'sync-standards.local.json';
const LINE_BREAK = /[\r\n]/u;

export type SyncPolicy = {
  readonly autoSync?: boolean;
  readonly ref?: string;
};

const parseSyncPolicy = (parsed: unknown): SyncPolicy => {
  if (!isRecord(parsed)) {
    throw new Error(`${SYNC_POLICY_FILE} must be a JSON object`);
  }
  const unsupportedFields = Object.keys(parsed).filter(
    (field) => field !== 'autoSync' && field !== 'ref',
  );
  if (unsupportedFields.length > 0) {
    throw new Error(
      `${SYNC_POLICY_FILE} contains unsupported field(s): ${unsupportedFields.join(', ')}`,
    );
  }
  if (parsed.autoSync !== undefined && typeof parsed.autoSync !== 'boolean') {
    throw new Error(`${SYNC_POLICY_FILE} "autoSync" must be a boolean`);
  }
  if (
    parsed.ref !== undefined &&
    (!isNonEmptyString(parsed.ref) || LINE_BREAK.test(parsed.ref))
  ) {
    throw new Error(
      `${SYNC_POLICY_FILE} "ref" must be a non-empty single-line string`,
    );
  }
  return { autoSync: parsed.autoSync, ref: parsed.ref };
};

export const readSyncPolicy = async (consumer: string): Promise<SyncPolicy> => {
  const path = join(consumer, SYNC_POLICY_FILE);
  const info = await lstat(path).catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (info === null) {
    return {};
  }
  if (!isContainedPath(consumer, SYNC_POLICY_FILE, 'file')) {
    throw new Error(
      `${SYNC_POLICY_FILE} must be a contained regular file; symlinked paths are not allowed`,
    );
  }
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${SYNC_POLICY_FILE} must contain valid JSON`, {
      cause: error,
    });
  }
  return parseSyncPolicy(parsed);
};

export const inspectSyncPolicy = async (
  consumer: string,
): Promise<ReadonlyArray<string>> => {
  try {
    await readSyncPolicy(consumer);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
};

// Policy validation is unconditional once the file exists. Selection happens
// afterward: explicit refs win for remote sources, while local paths are used
// as-is and ignore only the already-validated policy ref.
export const selectedSyncRef = (
  src: string,
  explicitRef: string | undefined,
  policy: SyncPolicy,
): string | undefined =>
  existsSync(src) ? explicitRef : (explicitRef ?? policy.ref);
