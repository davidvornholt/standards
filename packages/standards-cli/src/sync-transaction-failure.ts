import type { PinnedDirectory, PinnedTarget } from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import {
  removeOwnedTransaction,
  unpublishedArtifactNames,
} from './sync-transaction-artifact-cleanup';
import { cleanupTransaction } from './sync-transaction-cleanup';
import {
  assertTransactionOwner,
  readTransactionOwner,
} from './sync-transaction-ownership';
import { rollbackJournal } from './sync-transaction-rollback';
import {
  type MutationFault,
  TRANSACTION_DIRECTORY,
  type TransactionJournal,
} from './sync-transaction-types';

export type FailureResolution = {
  readonly failure: unknown;
  readonly needsStartupRecovery: boolean;
};

export const resolveTransactionFailure = async ({
  afterCleanupArtifactUnlink,
  afterCleanupReservationPartialWrite,
  committed,
  error,
  fault,
  journal,
  journalPublished,
  root,
  rootDirectory,
  targets,
  transaction,
}: {
  readonly afterCleanupArtifactUnlink?: (name: string) => Promise<void>;
  readonly afterCleanupReservationPartialWrite?: () => Promise<void>;
  readonly committed: boolean;
  readonly error: unknown;
  readonly fault: MutationFault;
  readonly journal: TransactionJournal;
  readonly journalPublished: boolean;
  readonly root: RepositoryRoot;
  readonly rootDirectory: PinnedDirectory;
  readonly targets: ReadonlyMap<string, PinnedTarget> | undefined;
  readonly transaction: PinnedDirectory;
}): Promise<FailureResolution> => {
  if (!journalPublished) {
    try {
      const owner = await readTransactionOwner(transaction);
      assertTransactionOwner(owner, root.identity, transaction);
      if (owner.id !== journal.id) {
        throw new Error('Transaction owner does not match its journal');
      }
      await removeOwnedTransaction({
        allowed: unpublishedArtifactNames,
        reservedName: TRANSACTION_DIRECTORY,
        root: rootDirectory,
        transaction,
      });
      return { failure: error, needsStartupRecovery: false };
    } catch (cleanupError) {
      return {
        failure: new AggregateError(
          [error, cleanupError],
          'Could not clean an unpublished filesystem transaction',
          { cause: error },
        ),
        needsStartupRecovery: false,
      };
    }
  }
  if (committed) {
    return { failure: error, needsStartupRecovery: false };
  }
  if (targets === undefined) {
    return { failure: error, needsStartupRecovery: true };
  }
  const recoveryErrors = [
    ...(await rollbackJournal({ fault, journal, targets, transaction })),
  ];
  if (recoveryErrors.length === 0) {
    recoveryErrors.push(
      ...(await cleanupTransaction({
        afterArtifactUnlink: afterCleanupArtifactUnlink,
        afterReservationPartialWrite: afterCleanupReservationPartialWrite,
        committed: false,
        fault,
        journal,
        root,
        rootDirectory,
        transaction,
      })),
    );
  }
  if (recoveryErrors.length === 0) {
    return { failure: error, needsStartupRecovery: false };
  }
  return {
    failure: new AggregateError(
      [error, ...recoveryErrors],
      'Standards filesystem transaction failed; recovery journal retained',
      { cause: error },
    ),
    needsStartupRecovery: false,
  };
};
