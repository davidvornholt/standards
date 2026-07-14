import { readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
  type PinnedTarget,
} from './sync-directory-handles';
import {
  identitiesMatch,
  inspectRepositoryFile,
  type RepositoryRoot,
} from './sync-filesystem';
import {
  removalBindingIdentity,
  resolveRemovalEntryName,
} from './sync-transaction-bound-remove';
import {
  fileMatchesDesired,
  fileMatchesExpected,
  inspectPinnedFile,
} from './sync-transaction-files';
import {
  assertTransactionOwner,
  readTransactionOwner,
} from './sync-transaction-ownership';
import {
  TRANSACTION_COMMITTED,
  TRANSACTION_JOURNAL,
  TRANSACTION_OWNER,
  type TransactionJournal,
} from './sync-transaction-types';

const PRIVATE_MODE = 0o600;

const artifact = (
  transaction: PinnedDirectory,
  name: string,
): PinnedTarget => ({ name, parent: transaction, rel: name });

const assertExactArtifact = async (
  transaction: PinnedDirectory,
  name: string,
  contents: Buffer,
): Promise<void> => {
  const state = await inspectPinnedFile(
    artifact(transaction, await resolveRemovalEntryName(transaction, name)),
  );
  if (
    state.contents === null ||
    state.mode !== PRIVATE_MODE ||
    !state.contents.equals(contents)
  ) {
    throw new Error(`Transaction artifact is invalid: ${name}`);
  }
};

const validateOperationArtifact = async ({
  committed,
  journal,
  name,
  root,
  transaction,
}: {
  readonly committed: boolean;
  readonly journal: TransactionJournal;
  readonly name: string;
  readonly root: RepositoryRoot;
  readonly transaction: PinnedDirectory;
}): Promise<void> => {
  const operation = journal.operations.find(
    ({ backup, stage }) => name === backup || name === stage,
  );
  if (operation === undefined) {
    return;
  }
  const state = await inspectPinnedFile(
    artifact(transaction, await resolveRemovalEntryName(transaction, name)),
  );
  if (name === operation.backup) {
    if (!(committed && fileMatchesExpected(state, operation.before))) {
      throw new Error(`Transaction backup is invalid: ${operation.rel}`);
    }
    return;
  }
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

const validateArtifact = async ({
  committed,
  journal,
  name,
  root,
  transaction,
}: {
  readonly committed: boolean;
  readonly journal: TransactionJournal;
  readonly name: string;
  readonly root: RepositoryRoot;
  readonly transaction: PinnedDirectory;
}): Promise<void> => {
  if (name === TRANSACTION_JOURNAL) {
    await assertExactArtifact(
      transaction,
      name,
      Buffer.from(`${JSON.stringify(journal)}\n`),
    );
    return;
  }
  if (name === TRANSACTION_COMMITTED) {
    if (!committed) {
      throw new Error('Rolled-back transaction has a committed marker');
    }
    await assertExactArtifact(transaction, name, Buffer.alloc(0));
    return;
  }
  if (name !== TRANSACTION_OWNER) {
    await validateOperationArtifact({
      committed,
      journal,
      name,
      root,
      transaction,
    });
    return;
  }
  const owner = await readTransactionOwner(transaction);
  assertTransactionOwner(owner, root.identity, transaction);
  if (owner.id !== journal.id) {
    throw new Error('Transaction owner does not match its journal');
  }
  const state = await inspectPinnedFile(
    artifact(transaction, await resolveRemovalEntryName(transaction, name)),
  );
  if (state.mode !== PRIVATE_MODE) {
    throw new Error('Transaction owner mode is invalid');
  }
};

export const assertTransactionArtifacts = async ({
  committed,
  journal,
  root,
  transaction,
}: {
  readonly committed: boolean;
  readonly journal: TransactionJournal;
  readonly root: RepositoryRoot;
  readonly transaction: PinnedDirectory;
}): Promise<void> => {
  const entries = await readdir(directoryEntryPath(transaction, '.'));
  const allowed = new Set([
    TRANSACTION_OWNER,
    TRANSACTION_JOURNAL,
    ...(committed ? [TRANSACTION_COMMITTED] : []),
    ...journal.operations.flatMap(({ backup, stage }) =>
      stage === null ? [backup] : [backup, stage],
    ),
  ]);
  const logicalNames = entries.map((entry) => {
    if (allowed.has(entry)) {
      return entry;
    }
    const logical = [...allowed].find(
      (name) => removalBindingIdentity(name, entry) !== null,
    );
    if (logical === undefined) {
      throw new Error(`Transaction artifact is unexpected: ${entry}`);
    }
    return logical;
  });
  if (new Set(logicalNames).size !== logicalNames.length) {
    throw new Error('Transaction artifact and removal binding both exist');
  }
  await Promise.all(
    logicalNames.map((name) =>
      validateArtifact({ committed, journal, name, root, transaction }),
    ),
  );
};
