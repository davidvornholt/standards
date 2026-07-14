import { assertRepositoryRelativePath } from './sync-filesystem';
import { nullableJournalIdentityString } from './sync-journal-identity';
import { isReservedTransactionPath } from './sync-transaction-artifact-names';
import type { JournalOperation } from './sync-transaction-types';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_FILE_MODE = 0o777;

export const journalRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

export const journalString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
};

const nullableString = (value: unknown, label: string): string | null =>
  value === null ? null : journalString(value, label);

const modeValue = (value: unknown, label: string): number | null => {
  if (value === null) {
    return null;
  }
  if (
    !(
      Number.isInteger(value) &&
      Number(value) >= 0 &&
      Number(value) <= MAX_FILE_MODE
    )
  ) {
    throw new Error(`${label} must be a Unix permission mode`);
  }
  return Number(value);
};

const fileState = (
  value: unknown,
  label: string,
  allowLegacyIdentity: boolean,
) => {
  const state = journalRecord(value, label);
  const dev = nullableJournalIdentityString(
    state.dev,
    `${label}.dev`,
    allowLegacyIdentity,
  );
  const hash = nullableString(state.hash, `${label}.hash`);
  const ino = nullableJournalIdentityString(
    state.ino,
    `${label}.ino`,
    allowLegacyIdentity,
  );
  const mode = modeValue(state.mode, `${label}.mode`);
  const fields = [dev, hash, ino, mode];
  if (
    !(
      fields.every((field) => field === null) ||
      fields.every((field) => field !== null)
    )
  ) {
    throw new Error(`${label} must describe either a present or missing file`);
  }
  if (hash !== null && !SHA256.test(hash)) {
    throw new Error(`${label}.hash must be a sha256 digest`);
  }
  return { dev, hash, ino, mode };
};

export const journalOperation = (
  value: unknown,
  index: number,
  allowLegacyIdentity: boolean,
): JournalOperation => {
  const label = `journal operations[${index}]`;
  const operation = journalRecord(value, label);
  const { kind } = operation;
  if (kind !== 'delete' && kind !== 'write') {
    throw new Error(`${label}.kind must be delete or write`);
  }
  const rel = journalString(operation.rel, `${label}.rel`);
  assertRepositoryRelativePath(rel, `${label}.rel`);
  if (isReservedTransactionPath(rel)) {
    throw new Error(`${label}.rel uses the reserved transaction path`);
  }
  const backup = journalString(operation.backup, `${label}.backup`);
  const stage = nullableString(operation.stage, `${label}.stage`);
  if (
    backup !== `old-${index}` ||
    stage !== (kind === 'write' ? `new-${index}` : null)
  ) {
    throw new Error(`${label} has invalid artifact names`);
  }
  const desired =
    operation.desired === null
      ? null
      : (() => {
          const state = journalRecord(operation.desired, `${label}.desired`);
          const hash = journalString(state.hash, `${label}.desired.hash`);
          const mode = modeValue(state.mode, `${label}.desired.mode`);
          if (!(SHA256.test(hash) && mode !== null)) {
            throw new Error(`${label}.desired is invalid`);
          }
          return { hash, mode };
        })();
  if ((kind === 'write') !== (desired !== null)) {
    throw new Error(`${label} desired state disagrees with its kind`);
  }
  return {
    backup,
    before: fileState(operation.before, `${label}.before`, allowLegacyIdentity),
    desired,
    kind,
    rel,
    stage,
  };
};
