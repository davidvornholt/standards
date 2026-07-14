import { randomUUID } from 'node:crypto';
import {
  assertMutationPlatform,
  type CreatedDirectory,
  closePinnedDirectories,
  openPinnedRoot,
  type PinnedDirectory,
  type PinnedTarget,
} from './sync-directory-handles';
import type { PreparedDirectory, RepositoryRoot } from './sync-filesystem';
import { assertPlanSingleFilesystem } from './sync-mount-identity';
import { type MutationTestHooks, noMutationFault } from './sync-mutation-hooks';
import {
  cleanupHooks,
  publicationHooks,
  recoverThenThrow,
} from './sync-mutation-lifecycle';
import {
  buildJournal,
  inspectCreatedParentPlan,
} from './sync-transaction-build';
import { cleanupTransaction } from './sync-transaction-cleanup';
import { commitJournal, markJournalCommitted } from './sync-transaction-commit';
import { resolveTransactionFailure } from './sync-transaction-failure';
import { stageWrites, type TransactionWrite } from './sync-transaction-files';
import { publishJournal } from './sync-transaction-journal';
import { createParentBinding } from './sync-transaction-parent-binding';
import { markCreatedParents } from './sync-transaction-parents';
import type { TransactionDelete } from './sync-transaction-plan';
import { preparePrunes, prepareTargets } from './sync-transaction-plan';
import {
  applyPrunes,
  assertPreparedParents,
  assertSingleFilesystem,
  transactionTargetMap,
} from './sync-transaction-prepare';
import { createTransactionDirectory } from './sync-transaction-publication';
import type {
  MutationFault,
  TransactionJournal,
} from './sync-transaction-types';
import { verifyDesiredRootTree } from './sync-transaction-verification';

export type { MutationTestHooks } from './sync-mutation-hooks';

export type PreparedWrite = TransactionWrite;
export type PreparedDelete = TransactionDelete;

type MutationPlan = {
  readonly deletes: ReadonlyArray<PreparedDelete>;
  readonly prunes: ReadonlyArray<PreparedDirectory>;
  readonly root: RepositoryRoot;
  readonly writes: ReadonlyArray<PreparedWrite>;
};

const bindCreatedParent =
  (fault: MutationFault, journal: TransactionJournal, root: PinnedDirectory) =>
  async ({ rel }: CreatedDirectory, directory: PinnedDirectory) => {
    await createParentBinding({
      afterSync: () => fault('parent-binding', rel, 'after'),
      index: journal.createdParents.indexOf(rel),
      journal,
      parent: directory,
      root,
    });
  };

export const applyRepositoryMutations = async (
  { deletes, prunes, root, writes }: MutationPlan,
  hooks: MutationTestHooks = {},
): Promise<void> => {
  await assertMutationPlatform();
  const opened: Array<PinnedDirectory> = [];
  const created: Array<CreatedDirectory> = [];
  const fault = hooks.fault ?? noMutationFault;
  const id = randomUUID();
  await assertPlanSingleFilesystem(root, [
    ...writes.map(({ rel }) => rel),
    ...deletes.map(({ rel }) => rel),
  ]);
  const createdParents = await inspectCreatedParentPlan(root, writes);
  const journal = buildJournal({ createdParents, deletes, id, root, writes });
  const rootDirectory = await openPinnedRoot(root);
  opened.push(rootDirectory);
  const transaction = await createTransactionDirectory(rootDirectory, id, {
    afterMkdir: hooks.afterTransactionMkdir,
    afterOwnerFinalSync: hooks.afterOwnerFinalSync,
    afterOwnerPartialWrite: hooks.afterOwnerPartialWrite,
    afterOwnerReservationFinalSync: hooks.afterOwnerReservationFinalSync,
    afterReservationFinalSync: hooks.afterReservationFinalSync,
    afterReservationPartialWrite: hooks.afterReservationPartialWrite,
    beforeMkdir: hooks.beforeTransactionMkdir,
  });
  opened.push(transaction);
  let journalPublished = false;
  let committed = false;
  let failure: unknown;
  let needsStartupRecovery = false;
  let finalDecisionStarted = false;
  let allTargets: ReadonlyMap<string, PinnedTarget> | undefined;
  try {
    await publishJournal(transaction, journal, publicationHooks(hooks));
    journalPublished = true;
    await hooks.afterJournal?.();
    await stageWrites(transaction, writes, fault, journal);
    const targets = await prepareTargets({
      afterCreate: bindCreatedParent(fault, journal, rootDirectory),
      created,
      deletes,
      fault,
      opened,
      root,
      writes,
    });
    await markCreatedParents(created, journal, fault);
    assertPreparedParents(createdParents, created);
    allTargets = transactionTargetMap(targets.writes, targets.deletes);
    assertSingleFilesystem(transaction, allTargets);
    const pruneTargets = await preparePrunes(root, prunes, opened, created);
    await hooks.beforeMutation?.();
    await commitJournal({
      beforeCommitMarker: hooks.beforeCommitMarker,
      fault,
      journal,
      root,
      targets: allTargets,
      transaction,
    });
    finalDecisionStarted = true;
    await hooks.beforeCommitDecision?.();
    await verifyDesiredRootTree(root, journal);
    await markJournalCommitted(transaction, fault);
    committed = true;
    await hooks.afterCommitMarker?.();
    await verifyDesiredRootTree(root, journal);
    await hooks.afterCommitted?.();
    await applyPrunes(pruneTargets);
    await hooks.beforeCleanup?.();
    const cleanupErrors = await cleanupTransaction({
      ...cleanupHooks(hooks),
      committed: true,
      fault,
      journal,
      root,
      rootDirectory,
      transaction,
    });
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        'Standards sync committed; transaction cleanup is pending',
      );
    }
  } catch (error) {
    if (finalDecisionStarted) {
      failure = error;
    } else {
      const resolution = await resolveTransactionFailure({
        afterCleanupArtifactUnlink: hooks.afterCleanupArtifactUnlink,
        afterCleanupReservationPartialWrite:
          hooks.afterCleanupReservationPartialWrite,
        committed,
        error,
        fault,
        journal,
        journalPublished,
        root,
        rootDirectory,
        targets: allTargets,
        transaction,
      });
      ({ failure, needsStartupRecovery } = resolution);
    }
  } finally {
    await closePinnedDirectories(opened);
  }
  if (failure === undefined) {
    return;
  }
  if (!needsStartupRecovery) {
    throw failure;
  }
  return recoverThenThrow(root, failure);
};
