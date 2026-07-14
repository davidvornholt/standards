import { constants } from 'node:fs';
import { link, open } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
  type PinnedTarget,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch, type RepositoryRoot } from './sync-filesystem';
import { backupTargetForRemoval } from './sync-transaction-backup';
import {
  assertPinnedFileExpected,
  fileMatchesDesired,
  inspectPinnedFile,
} from './sync-transaction-files';
import { assertParentsLinked } from './sync-transaction-plan';
import {
  type FileOperation,
  type JournalOperation,
  type MutationFault,
  TRANSACTION_COMMITTED,
  type TransactionJournal,
} from './sync-transaction-types';

const PRIVATE_MODE = 0o600;

const artifactTarget = (
  transaction: PinnedDirectory,
  name: string,
  rel: string,
): PinnedTarget => ({ name, parent: transaction, rel });

const faulted = async (
  fault: MutationFault,
  operation: FileOperation,
  rel: string,
  action: () => Promise<void>,
): Promise<void> => {
  await fault(operation, rel, 'before');
  await action();
  await fault(operation, rel, 'after');
};

const syncMutation = async (
  parent: PinnedDirectory,
  transaction: PinnedDirectory,
  rel: string,
  fault: MutationFault,
): Promise<void> => {
  await fault('fsync', rel, 'before');
  await syncPinnedDirectory(parent);
  await syncPinnedDirectory(transaction);
  await fault('fsync', rel, 'after');
};

const assertInstalled = async (
  transaction: PinnedDirectory,
  target: PinnedTarget,
  operation: JournalOperation,
): Promise<void> => {
  if (operation.stage === null || operation.desired === null) {
    throw new Error(`Write operation is incomplete: ${operation.rel}`);
  }
  const [stage, installed] = await Promise.all([
    inspectPinnedFile(
      artifactTarget(transaction, operation.stage, operation.rel),
    ),
    inspectPinnedFile(target),
  ]);
  if (
    !(
      fileMatchesDesired(installed, operation.desired) &&
      identitiesMatch(stage.identity, installed.identity)
    )
  ) {
    throw new Error(`Installed file failed verification: ${operation.rel}`);
  }
};

const commitOperation = async ({
  fault,
  operation,
  root,
  target,
  transaction,
}: {
  readonly fault: MutationFault;
  readonly operation: JournalOperation;
  readonly root: RepositoryRoot;
  readonly target: PinnedTarget;
  readonly transaction: PinnedDirectory;
}): Promise<void> => {
  await assertParentsLinked(root, [target]);
  await assertPinnedFileExpected(target, operation.before);
  if (operation.before.hash !== null) {
    if (operation.kind === 'delete') {
      await fault('delete', operation.rel, 'before');
    }
    await backupTargetForRemoval({ fault, operation, target, transaction });
  }
  if (operation.kind === 'delete') {
    return;
  }
  if (operation.stage === null) {
    throw new Error(`Write operation has no staged file: ${operation.rel}`);
  }
  const { stage } = operation;
  await faulted(fault, 'install', operation.rel, () =>
    link(
      directoryEntryPath(transaction, stage),
      directoryEntryPath(target.parent, target.name),
    ),
  );
  await assertInstalled(transaction, target, operation);
  await syncMutation(target.parent, transaction, operation.rel, fault);
};

export const commitJournal = async ({
  beforeCommitMarker,
  fault,
  journal,
  root,
  targets,
  transaction,
}: {
  readonly beforeCommitMarker?: () => Promise<void>;
  readonly fault: MutationFault;
  readonly journal: TransactionJournal;
  readonly root: RepositoryRoot;
  readonly targets: ReadonlyMap<string, PinnedTarget>;
  readonly transaction: PinnedDirectory;
}): Promise<void> => {
  for (const operation of journal.operations) {
    const target = targets.get(operation.rel);
    if (target === undefined) {
      throw new Error(`Missing pinned transaction target: ${operation.rel}`);
    }
    if (operation.rel === journal.lockRel) {
      // biome-ignore lint/performance/noAwaitInLoops: the lock boundary must follow prior durable operations
      await beforeCommitMarker?.();
      await assertParentsLinked(root, [...targets.values()]);
    }
    // Commit order is durable WAL order and the lock operation is last.
    await commitOperation({
      fault,
      operation,
      root,
      target,
      transaction,
    });
  }
};

export const markJournalCommitted = async (
  transaction: PinnedDirectory,
  fault: MutationFault,
): Promise<void> => {
  const handle = await open(
    directoryEntryPath(transaction, TRANSACTION_COMMITTED),
    constants.O_CREAT +
      constants.O_EXCL +
      constants.O_WRONLY +
      constants.O_NOFOLLOW,
    PRIVATE_MODE,
  );
  try {
    await handle.sync();
    await fault('committed-file', TRANSACTION_COMMITTED, 'after');
  } finally {
    await handle.close();
  }
  await syncPinnedDirectory(transaction);
  await fault('committed-dir', TRANSACTION_COMMITTED, 'after');
};
