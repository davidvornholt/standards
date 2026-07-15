import { assertRepositoryRelativePath } from './sync-filesystem';
import { journalIdentityString } from './sync-journal-identity';
import { parseStoredLinuxProcessIdentity } from './sync-process-identity';
import {
  isReservedTransactionPath,
  isUuidV4,
} from './sync-transaction-artifact-names';
import {
  journalOperation,
  journalRecord as record,
  journalString as stringValue,
} from './sync-transaction-journal-operation';
import { SYNC_LOCK_FILE } from './sync-transaction-namespace';
import {
  assertJournalSemantics,
  JOURNAL_VERSION,
  LEGACY_JOURNAL_VERSION,
  type TransactionJournal,
} from './sync-transaction-types';

export const parseJournal = (contents: string): TransactionJournal => {
  const value = record(JSON.parse(contents) as unknown, 'transaction journal');
  if (
    value.version !== JOURNAL_VERSION &&
    value.version !== LEGACY_JOURNAL_VERSION
  ) {
    throw new Error('transaction journal has an unsupported version');
  }
  const allowLegacyIdentity = value.version === LEGACY_JOURNAL_VERSION;
  const root = record(value.root, 'transaction journal root');
  const dev = journalIdentityString(
    root.dev,
    'transaction journal root.dev',
    allowLegacyIdentity,
  );
  const ino = journalIdentityString(
    root.ino,
    'transaction journal root.ino',
    allowLegacyIdentity,
  );
  if (
    !(Array.isArray(value.operations) && Array.isArray(value.createdParents))
  ) {
    throw new Error('transaction journal operation lists are invalid');
  }
  const operations = value.operations.map((operation, index) =>
    journalOperation(operation, index, allowLegacyIdentity),
  );
  if (value.lockRel !== SYNC_LOCK_FILE) {
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
    lockRel: SYNC_LOCK_FILE as typeof SYNC_LOCK_FILE,
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
    lockRel: SYNC_LOCK_FILE,
    operations,
    ownerPid: Number(ownerPid),
    ownerProcess: parseStoredLinuxProcessIdentity(value.ownerProcess),
    root: { dev, ino },
    version: JOURNAL_VERSION,
  };
};
