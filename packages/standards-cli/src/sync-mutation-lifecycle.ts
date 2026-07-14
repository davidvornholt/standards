import type { RepositoryRoot } from './sync-filesystem';
import type { MutationTestHooks } from './sync-mutation-hooks';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';

export const publicationHooks = (hooks: MutationTestHooks) => ({
  afterJournalPartialWrite: hooks.afterJournalPartialWrite,
  afterJournalRename: hooks.afterJournalRename,
  beforeJournalTempOpen: hooks.beforeJournalTempOpen,
  beforeJournalRename: hooks.beforeJournalRename,
});

export const cleanupHooks = (hooks: MutationTestHooks) => ({
  afterArtifactUnlink: hooks.afterCleanupArtifactUnlink,
  afterRemoval: hooks.afterCleanupRemoval,
  afterReservationPartialWrite: hooks.afterCleanupReservationPartialWrite,
  beforeRename: hooks.afterCleanupParents,
  beforeRmdir: hooks.beforeCleanupRmdir,
});

const startupRecoveryFailure = (
  failure: unknown,
  recoveryError: unknown,
): AggregateError =>
  new AggregateError(
    [failure, recoveryError],
    'Standards filesystem transaction failed; recovery journal retained',
    { cause: recoveryError },
  );

export const recoverThenThrow = async (
  root: RepositoryRoot,
  failure: unknown,
): Promise<never> => {
  try {
    await recoverRepositoryTransactions(root);
  } catch (recoveryError) {
    throw startupRecoveryFailure(failure, recoveryError);
  }
  throw failure;
};
