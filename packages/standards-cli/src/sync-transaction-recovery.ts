import process from 'node:process';
import {
  assertMutationPlatform,
  closePinnedDirectories,
  openPinnedRoot,
  type PinnedDirectory,
  type PinnedTarget,
} from './sync-directory-handles';
import { pinTarget } from './sync-directory-traversal';
import { identitiesMatch, type RepositoryRoot } from './sync-filesystem';
import { cleanupTransaction } from './sync-transaction-cleanup';
import {
  fileMatchesDesired,
  inspectPinnedFile,
} from './sync-transaction-files';
import { hasCommittedMarker, readJournal } from './sync-transaction-journal';
import { recoverTransactionPublication } from './sync-transaction-publication-recovery';
import { prepareRecoveryState } from './sync-transaction-recovery-state';
import { rollbackJournal } from './sync-transaction-rollback';
import {
  TRANSACTION_DIRECTORY,
  type TransactionJournal,
} from './sync-transaction-types';

const noFault = () => Promise.resolve();
const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

const targetsForJournal = async (
  root: RepositoryRoot,
  journal: TransactionJournal,
  opened: Array<PinnedDirectory>,
): Promise<ReadonlyMap<string, PinnedTarget>> => {
  const targets = new Map<string, PinnedTarget>();
  for (const operation of journal.operations) {
    try {
      // Recovery pins every surviving parent without creating new state.
      // biome-ignore lint/performance/noAwaitInLoops: traversal must fail-preserve per path
      const target = await pinTarget({
        createParents: false,
        created: [],
        opened,
        rel: operation.rel,
        root,
      });
      targets.set(operation.rel, target);
    } catch (error) {
      if (!(missing(error) && operation.before.hash === null)) {
        throw error;
      }
    }
  }
  return targets;
};

const verifyCommitted = async (
  journal: TransactionJournal,
  targets: ReadonlyMap<string, PinnedTarget>,
): Promise<void> => {
  await Promise.all(
    journal.operations.map(async (operation) => {
      const target = targets.get(operation.rel);
      if (target === undefined) {
        if (operation.kind === 'delete') {
          return;
        }
        throw new Error(`Committed target parent is missing: ${operation.rel}`);
      }
      const state = await inspectPinnedFile(target);
      if (operation.desired === null) {
        if (state.contents !== null) {
          throw new Error(`Committed deletion is incomplete: ${operation.rel}`);
        }
      } else if (!fileMatchesDesired(state, operation.desired)) {
        throw new Error(`Committed write is incomplete: ${operation.rel}`);
      }
    }),
  );
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const recoverRepositoryTransactions = async (
  root: RepositoryRoot,
  mutate = true,
): Promise<void> => {
  await assertMutationPlatform();
  const opened: Array<PinnedDirectory> = [];
  const rootDirectory = await openPinnedRoot(root);
  opened.push(rootDirectory);
  try {
    const state = await prepareRecoveryState({
      mutate,
      opened,
      root,
      rootDirectory,
    });
    if (state.done) {
      return;
    }
    const owner = await recoverTransactionPublication({
      reservation: state.reservation,
      root,
      rootDirectory,
      transaction: state.transaction,
    });
    if (owner === null) {
      return;
    }
    const journal = await readJournal(state.transaction);
    if (owner.id !== journal.id) {
      throw new Error('Transaction ownership records disagree');
    }
    if (
      !identitiesMatch(root.identity, {
        dev: Number(journal.root.dev),
        ino: Number(journal.root.ino),
      })
    ) {
      throw new Error(
        `Transaction journal belongs to a different repository root: ${TRANSACTION_DIRECTORY}`,
      );
    }
    if (journal.ownerPid !== process.pid && processIsAlive(journal.ownerPid)) {
      throw new Error(`Another standards sync owns ${TRANSACTION_DIRECTORY}`);
    }
    const targets = await targetsForJournal(root, journal, opened);
    const committed = await hasCommittedMarker(state.transaction);
    const errors: Array<unknown> = committed
      ? await verifyCommitted(journal, targets).then(() => [])
      : [
          ...(await rollbackJournal({
            fault: noFault,
            journal,
            targets,
            transaction: state.transaction,
          })),
        ];
    if (errors.length === 0) {
      errors.push(
        ...(await cleanupTransaction({
          committed,
          fault: noFault,
          journal,
          root,
          rootDirectory,
          transaction: state.transaction,
        })),
      );
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Filesystem recovery retained ${TRANSACTION_DIRECTORY}`,
      );
    }
  } finally {
    await closePinnedDirectories(opened);
  }
};
