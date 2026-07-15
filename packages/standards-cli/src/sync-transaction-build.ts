import process from 'node:process';
import { inspectRepositoryNode, type RepositoryRoot } from './sync-filesystem';
import { captureLinuxProcessIdentity } from './sync-process-identity';
import { isReservedTransactionPath } from './sync-transaction-artifact-names';
import type { TransactionWrite } from './sync-transaction-files';
import { SYNC_LOCK_FILE } from './sync-transaction-namespace';
import type { TransactionDelete } from './sync-transaction-plan';
import {
  effectiveMode,
  expectedFile,
  hashContents,
  JOURNAL_VERSION,
  type JournalOperation,
  journalParentPaths,
  type TransactionJournal,
} from './sync-transaction-types';

export const inspectCreatedParentPlan = async (
  root: RepositoryRoot,
  writes: ReadonlyArray<TransactionWrite>,
): Promise<ReadonlyArray<string>> => {
  const candidates = [
    ...new Set(writes.flatMap(({ rel }) => journalParentPaths(rel))),
  ];
  const inspections = await Promise.all(
    candidates.map(async (rel) => ({
      node: await inspectRepositoryNode(root, rel),
      rel,
    })),
  );
  return inspections
    .filter(({ node }) => node.info === null)
    .map(({ rel }) => rel);
};

export const buildJournal = ({
  createdParents,
  deletes,
  id,
  root,
  writes,
}: {
  readonly createdParents: ReadonlyArray<string>;
  readonly deletes: ReadonlyArray<TransactionDelete>;
  readonly id: string;
  readonly root: RepositoryRoot;
  readonly writes: ReadonlyArray<TransactionWrite>;
}): TransactionJournal => {
  const nonLockWrites = writes.filter(({ rel }) => rel !== SYNC_LOCK_FILE);
  const lockWrites = writes.filter(({ rel }) => rel === SYNC_LOCK_FILE);
  if (lockWrites.length !== 1) {
    throw new Error('Standards filesystem transaction requires one lock write');
  }
  const reserved = [...writes, ...deletes].find(({ rel }) =>
    isReservedTransactionPath(rel),
  );
  if (reserved !== undefined) {
    throw new Error(`Mutation uses reserved transaction path: ${reserved.rel}`);
  }
  const inputs = [
    ...deletes.map((deletion) => ({
      kind: 'delete' as const,
      value: deletion,
    })),
    ...nonLockWrites.map((write) => ({ kind: 'write' as const, value: write })),
    ...lockWrites.map((write) => ({ kind: 'write' as const, value: write })),
  ];
  const operations: ReadonlyArray<JournalOperation> = inputs.map(
    ({ kind, value }, index) => ({
      backup: `old-${index}`,
      before: expectedFile(value.before),
      desired:
        kind === 'write'
          ? {
              hash: hashContents(value.contents),
              mode: effectiveMode(value.mode),
            }
          : null,
      kind,
      rel: value.rel,
      stage: kind === 'write' ? `new-${index}` : null,
    }),
  );
  return {
    createdParents,
    id,
    lockRel: SYNC_LOCK_FILE,
    operations,
    ownerPid: process.pid,
    ownerProcess: captureLinuxProcessIdentity(),
    root: { dev: String(root.identity.dev), ino: String(root.identity.ino) },
    version: JOURNAL_VERSION,
  };
};
