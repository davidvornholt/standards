import { assertRepositoryRelativePath } from './sync-filesystem';
import { parseStoredLinuxProcessIdentity } from './sync-process-identity';
import {
  isReservedTransactionPath,
  isUuidV4,
} from './sync-transaction-artifact-names';
import {
  assertJournalSemantics,
  JOURNAL_VERSION,
  type JournalOperation,
  LEGACY_JOURNAL_VERSION,
  type TransactionJournal,
} from './sync-transaction-types';

const SHA256 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^\d+$/u;
const MAX_FILE_MODE = 0o777;

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
};

const nullableString = (value: unknown, label: string): string | null =>
  value === null ? null : stringValue(value, label);

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

const fileState = (value: unknown, label: string) => {
  const state = record(value, label);
  const dev = nullableString(state.dev, `${label}.dev`);
  const hash = nullableString(state.hash, `${label}.hash`);
  const ino = nullableString(state.ino, `${label}.ino`);
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
  if (
    (dev !== null && !DECIMAL.test(dev)) ||
    (ino !== null && !DECIMAL.test(ino))
  ) {
    throw new Error(`${label} has an invalid filesystem identity`);
  }
  if (hash !== null && !SHA256.test(hash)) {
    throw new Error(`${label}.hash must be a sha256 digest`);
  }
  return { dev, hash, ino, mode };
};

const operationValue = (value: unknown, index: number): JournalOperation => {
  const label = `journal operations[${index}]`;
  const operation = record(value, label);
  const { kind } = operation;
  if (kind !== 'delete' && kind !== 'write') {
    throw new Error(`${label}.kind must be delete or write`);
  }
  const rel = stringValue(operation.rel, `${label}.rel`);
  assertRepositoryRelativePath(rel, `${label}.rel`);
  if (isReservedTransactionPath(rel)) {
    throw new Error(`${label}.rel uses the reserved transaction path`);
  }
  const backup = stringValue(operation.backup, `${label}.backup`);
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
          const state = record(operation.desired, `${label}.desired`);
          const hash = stringValue(state.hash, `${label}.desired.hash`);
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
    before: fileState(operation.before, `${label}.before`),
    desired,
    kind,
    rel,
    stage,
  };
};

export const parseJournal = (contents: string): TransactionJournal => {
  const value = record(JSON.parse(contents) as unknown, 'transaction journal');
  if (
    value.version !== JOURNAL_VERSION &&
    value.version !== LEGACY_JOURNAL_VERSION
  ) {
    throw new Error('transaction journal has an unsupported version');
  }
  const root = record(value.root, 'transaction journal root');
  const dev = stringValue(root.dev, 'transaction journal root.dev');
  const ino = stringValue(root.ino, 'transaction journal root.ino');
  if (!(DECIMAL.test(dev) && DECIMAL.test(ino))) {
    throw new Error('transaction journal root identity is invalid');
  }
  if (
    !(Array.isArray(value.operations) && Array.isArray(value.createdParents))
  ) {
    throw new Error('transaction journal operation lists are invalid');
  }
  const operations = value.operations.map(operationValue);
  if (value.lockRel !== 'sync-standards.lock') {
    throw new Error('transaction journal lockRel is invalid');
  }
  const rels = operations.map(({ rel }) => rel);
  if (new Set(rels).size !== rels.length) {
    throw new Error('transaction journal contains duplicate target paths');
  }
  const createdParents = value.createdParents.map((entry, index) => {
    const rel = stringValue(entry, `journal createdParents[${index}]`);
    assertRepositoryRelativePath(rel, `journal createdParents[${index}]`);
    if (isReservedTransactionPath(rel)) {
      throw new Error('transaction journal created parent is reserved');
    }
    return rel;
  });
  if (new Set(createdParents).size !== createdParents.length) {
    throw new Error('transaction journal contains duplicate created parents');
  }
  assertJournalSemantics(operations, createdParents);
  const { ownerPid } = value;
  const id = stringValue(value.id, 'transaction journal id');
  if (!(Number.isSafeInteger(ownerPid) && Number(ownerPid) > 0)) {
    throw new Error('transaction journal ownerPid is invalid');
  }
  if (!isUuidV4(id)) {
    throw new Error('transaction journal id is invalid');
  }
  const base = {
    createdParents,
    id,
    lockRel: 'sync-standards.lock' as const,
    operations,
    ownerPid: Number(ownerPid),
    root: { dev, ino },
  };
  if (value.version === LEGACY_JOURNAL_VERSION) {
    if (value.ownerProcess !== undefined) {
      throw new Error('legacy transaction journal has ownerProcess');
    }
    return { ...base, version: LEGACY_JOURNAL_VERSION };
  }
  return {
    createdParents,
    id,
    lockRel: 'sync-standards.lock',
    operations,
    ownerPid: Number(ownerPid),
    ownerProcess: parseStoredLinuxProcessIdentity(value.ownerProcess),
    root: { dev, ino },
    version: JOURNAL_VERSION,
  };
};
