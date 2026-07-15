import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import process from 'node:process';
import type { FileState } from './sync-filesystem';
import {
  assertFilesystemIdentityComponent,
  type NodeIdentity,
} from './sync-node-identity';
import type { LinuxProcessIdentity } from './sync-process-identity';
import {
  TRANSACTION_CLEANUP as NAMESPACE_TRANSACTION_CLEANUP,
  TRANSACTION_COMMITTED as NAMESPACE_TRANSACTION_COMMITTED,
  TRANSACTION_DIRECTORY as NAMESPACE_TRANSACTION_DIRECTORY,
  TRANSACTION_JOURNAL as NAMESPACE_TRANSACTION_JOURNAL,
  TRANSACTION_JOURNAL_TEMP as NAMESPACE_TRANSACTION_JOURNAL_TEMP,
  TRANSACTION_OWNER as NAMESPACE_TRANSACTION_OWNER,
  TRANSACTION_OWNER_PUBLICATION_PREFIX as NAMESPACE_TRANSACTION_OWNER_PUBLICATION_PREFIX,
  TRANSACTION_OWNER_RESERVATION as NAMESPACE_TRANSACTION_OWNER_RESERVATION,
  TRANSACTION_PARENT_BINDING_PREFIX as NAMESPACE_TRANSACTION_PARENT_BINDING_PREFIX,
  TRANSACTION_PUBLICATION_PREFIX as NAMESPACE_TRANSACTION_PUBLICATION_PREFIX,
  TRANSACTION_RESERVATION as NAMESPACE_TRANSACTION_RESERVATION,
  SYNC_LOCK_FILE,
} from './sync-transaction-namespace';

export const TRANSACTION_CLEANUP = NAMESPACE_TRANSACTION_CLEANUP;
export const TRANSACTION_COMMITTED = NAMESPACE_TRANSACTION_COMMITTED;
export const TRANSACTION_DIRECTORY = NAMESPACE_TRANSACTION_DIRECTORY;
export const TRANSACTION_JOURNAL = NAMESPACE_TRANSACTION_JOURNAL;
export const TRANSACTION_JOURNAL_TEMP = NAMESPACE_TRANSACTION_JOURNAL_TEMP;
export const TRANSACTION_OWNER = NAMESPACE_TRANSACTION_OWNER;
export const TRANSACTION_OWNER_PUBLICATION_PREFIX =
  NAMESPACE_TRANSACTION_OWNER_PUBLICATION_PREFIX;
export const TRANSACTION_OWNER_RESERVATION =
  NAMESPACE_TRANSACTION_OWNER_RESERVATION;
export const TRANSACTION_PARENT_BINDING_PREFIX =
  NAMESPACE_TRANSACTION_PARENT_BINDING_PREFIX;
export const TRANSACTION_PUBLICATION_PREFIX =
  NAMESPACE_TRANSACTION_PUBLICATION_PREFIX;
export const TRANSACTION_RESERVATION = NAMESPACE_TRANSACTION_RESERVATION;
export const LEGACY_JOURNAL_VERSION = 1;
export const JOURNAL_VERSION = 2;

export type ExpectedFile = {
  readonly dev: string | null;
  readonly hash: string | null;
  readonly ino: string | null;
  readonly mode: number | null;
};

export type DesiredFile = {
  readonly hash: string;
  readonly mode: number;
};

export type JournalOperation = {
  readonly backup: string;
  readonly before: ExpectedFile;
  readonly desired: DesiredFile | null;
  readonly kind: 'delete' | 'write';
  readonly rel: string;
  readonly stage: string | null;
};

type TransactionJournalBase = {
  readonly createdParents: ReadonlyArray<string>;
  readonly id: string;
  readonly lockRel: typeof SYNC_LOCK_FILE;
  readonly operations: ReadonlyArray<JournalOperation>;
  readonly ownerPid: number;
  readonly root: { readonly dev: string; readonly ino: string };
};

export type TransactionJournal =
  | (TransactionJournalBase & {
      readonly version: typeof LEGACY_JOURNAL_VERSION;
    })
  | (TransactionJournalBase & {
      readonly ownerProcess: LinuxProcessIdentity;
      readonly version: typeof JOURNAL_VERSION;
    });

export type TransactionFileOperation =
  | 'backup-link'
  | 'backup-parent-fsync'
  | 'backup-transaction-fsync'
  | 'backup-unlink'
  | 'install'
  | 'rollback-remove'
  | 'rollback-remove-bind'
  | 'rollback-restore'
  | 'rollback-restore-bind';

export type FileOperation =
  | 'close'
  | 'committed-dir'
  | 'committed-file'
  | 'delete'
  | 'fsync'
  | 'mkdir'
  | 'mkdir-fsync'
  | 'parent-marker'
  | 'parent-marker-fsync'
  | 'parent-binding'
  | 'parent-cleanup-binding-fsync'
  | 'parent-cleanup-binding-unlink'
  | 'parent-cleanup-directory-fsync'
  | 'parent-cleanup-marker-unlink'
  | 'parent-cleanup-parent-fsync'
  | 'parent-cleanup-rmdir'
  | 'parent-cleanup-reservation-fsync'
  | 'parent-cleanup-reservation-unlink'
  | 'parent-cleanup-token'
  | 'parent-cleanup-token-unlink'
  | 'parent-cleanup-token-write'
  | 'write'
  | TransactionFileOperation;

export type MutationFault = (
  operation: FileOperation,
  rel: string,
  timing?: 'after' | 'before',
) => Promise<void>;

export const hashContents = (contents: Uint8Array): string =>
  createHash('sha256').update(contents).digest('hex');

export const expectedFile = (state: FileState): ExpectedFile => ({
  dev: state.identity === null ? null : String(state.identity.dev),
  hash: state.contents === null ? null : hashContents(state.contents),
  ino: state.identity === null ? null : String(state.identity.ino),
  mode: state.mode,
});

export const expectedIdentity = (state: ExpectedFile): NodeIdentity | null =>
  state.dev === null || state.ino === null
    ? null
    : {
        dev: assertFilesystemIdentityComponent(
          BigInt(state.dev),
          'Expected file dev',
        ),
        ino: assertFilesystemIdentityComponent(
          BigInt(state.ino),
          'Expected file ino',
        ),
      };

export const effectiveMode = (mode: number | null): number =>
  // biome-ignore lint/suspicious/noBitwiseOperators: applying a Unix umask is intentionally bitwise
  mode ?? 0o666 & ~process.umask();

export const removedBackupName = (backup: string): string =>
  backup.replace('old-', 'removed-');

export const journalParentPaths = (rel: string): ReadonlyArray<string> => {
  const parts = dirname(rel)
    .split('/')
    .filter((part) => part !== '.');
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
};

export const assertJournalSemantics = (
  operations: ReadonlyArray<JournalOperation>,
  createdParents: ReadonlyArray<string>,
): void => {
  const lockOps = operations.filter(({ rel }) => rel === SYNC_LOCK_FILE);
  const finalOperation = operations.at(-1);
  if (
    lockOps.length !== 1 ||
    finalOperation !== lockOps[0] ||
    finalOperation.kind !== 'write' ||
    finalOperation.desired === null ||
    finalOperation.stage === null
  ) {
    throw new Error('transaction journal requires one final lockfile write');
  }
  const writeParents = [
    ...new Set(
      operations
        .filter(({ kind }) => kind === 'write')
        .flatMap(({ rel }) => journalParentPaths(rel)),
    ),
  ];
  const createdSet = new Set(createdParents);
  const inJournalOrder = writeParents.filter((rel) => createdSet.has(rel));
  if (
    createdParents.some((rel) => !writeParents.includes(rel)) ||
    inJournalOrder.some((rel, index) => rel !== createdParents[index]) ||
    createdParents.some((rel) =>
      writeParents.some(
        (candidate) =>
          candidate.startsWith(`${rel}/`) && !createdSet.has(candidate),
      ),
    ) ||
    operations.some(({ rel }) => createdSet.has(rel))
  ) {
    throw new Error('transaction journal created parents are inconsistent');
  }
};
