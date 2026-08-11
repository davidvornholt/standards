import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { automationProofProblems } from './automation-proof-validation';
import { isContainedPath } from './contained-path';
import { isNonEmptyString, isRecord } from './github-settings-parse';
import {
  hasControlCharacter,
  type NotificationPolicy,
  SYNC_POLICY_FILE as POLICY_FILE,
  parseIsolationFields,
  type SyncAutomationPolicy,
} from './sync-policy-isolation';

export const SYNC_POLICY_FILE = POLICY_FILE;

export type SyncPolicy = {
  readonly autoSync?: boolean;
  readonly ref?: string;
  readonly automation?: SyncAutomationPolicy;
  readonly notifications?: NotificationPolicy;
  readonly recoveryAgeRecipients?: ReadonlyArray<string>;
};

export const parseSyncPolicy = (parsed: unknown): SyncPolicy => {
  if (!isRecord(parsed)) {
    throw new Error(`${SYNC_POLICY_FILE} must be a JSON object`);
  }
  const unsupportedFields = Object.keys(parsed).filter(
    (field) =>
      field !== 'autoSync' &&
      field !== 'ref' &&
      field !== 'automation' &&
      field !== 'notifications' &&
      field !== 'recoveryAgeRecipients',
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
    (!isNonEmptyString(parsed.ref) || hasControlCharacter(parsed.ref))
  ) {
    throw new Error(
      `${SYNC_POLICY_FILE} "ref" must be a non-empty string without control characters`,
    );
  }
  const { automation, notifications, recoveryAgeRecipients } =
    parseIsolationFields(parsed);
  return {
    autoSync: parsed.autoSync,
    ref: parsed.ref,
    automation,
    notifications,
    recoveryAgeRecipients,
  };
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
    const policy = await readSyncPolicy(consumer);
    return automationProofProblems(consumer, policy);
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
