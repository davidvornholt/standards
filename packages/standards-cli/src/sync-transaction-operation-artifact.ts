import type { PinnedDirectory, PinnedTarget } from './sync-directory-handles';
import { inspectRepositoryFile } from './sync-file-inspection';
import { identitiesMatch, type RepositoryRoot } from './sync-filesystem';
import { rollbackBindingName } from './sync-transaction-bound-unlink';
import {
  fileMatchesDesired,
  fileMatchesExpected,
  inspectPinnedFile,
} from './sync-transaction-files';
import { resolveRemovalEntryName } from './sync-transaction-quarantine-read';
import {
  removedBackupName,
  type TransactionJournal,
} from './sync-transaction-types';

const artifact = (
  transaction: PinnedDirectory,
  name: string,
): PinnedTarget => ({ name, parent: transaction, rel: name });

const operationForName = (journal: TransactionJournal, name: string) =>
  journal.operations.find(
    ({ backup, stage }) =>
      name === backup ||
      name === removedBackupName(backup) ||
      name === rollbackBindingName(backup) ||
      name === rollbackBindingName(backup, 'backup') ||
      name === stage,
  );

type Operation = TransactionJournal['operations'][number];
type ArtifactState = Awaited<ReturnType<typeof inspectPinnedFile>>;

const assertRemovedTarget = (
  state: ArtifactState,
  operation: Operation,
): void => {
  if (!fileMatchesExpected(state, operation.before)) {
    throw new Error(`Transaction removed target is invalid: ${operation.rel}`);
  }
};

const assertRollbackTarget = (
  state: ArtifactState,
  operation: Operation,
): void => {
  const matchesDesired =
    operation.desired !== null && fileMatchesDesired(state, operation.desired);
  if (!(fileMatchesExpected(state, operation.before) || matchesDesired)) {
    throw new Error(
      `Transaction rollback quarantine is invalid: ${operation.rel}`,
    );
  }
};

const assertBackup = (
  state: ArtifactState,
  operation: Operation,
  committed: boolean,
): void => {
  if (!(committed && fileMatchesExpected(state, operation.before))) {
    throw new Error(`Transaction backup is invalid: ${operation.rel}`);
  }
};

const assertStage = async (
  state: ArtifactState,
  operation: Operation,
  committed: boolean,
  root: RepositoryRoot,
): Promise<void> => {
  if (
    operation.desired === null ||
    !fileMatchesDesired(state, operation.desired)
  ) {
    throw new Error(`Transaction stage is invalid: ${operation.rel}`);
  }
  if (committed) {
    const installed = await inspectRepositoryFile(root, operation.rel);
    if (!identitiesMatch(state.identity, installed.identity)) {
      throw new Error(`Committed stage inode is invalid: ${operation.rel}`);
    }
  }
};

export const validateOperationArtifact = async ({
  committed,
  journal,
  name,
  expected,
  root,
  transaction,
}: {
  readonly committed: boolean;
  readonly journal: TransactionJournal;
  readonly name: string;
  readonly expected?: import('./sync-node-identity').NodeIdentity;
  readonly root: RepositoryRoot;
  readonly transaction: PinnedDirectory;
}): Promise<void> => {
  const operation = operationForName(journal, name);
  if (operation === undefined) {
    return;
  }
  const state = await inspectPinnedFile(
    artifact(
      transaction,
      await resolveRemovalEntryName(transaction, name, expected),
    ),
  );
  if (name === removedBackupName(operation.backup)) {
    assertRemovedTarget(state, operation);
    return;
  }
  const rollback =
    name === rollbackBindingName(operation.backup) ||
    name === rollbackBindingName(operation.backup, 'backup');
  if (rollback) {
    assertRollbackTarget(state, operation);
    return;
  }
  if (name === operation.backup) {
    assertBackup(state, operation, committed);
    return;
  }
  await assertStage(state, operation, committed, root);
};
