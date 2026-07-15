import type { PinnedDirectory, PinnedTarget } from './sync-directory-handles';
import type { RepositoryRoot } from './sync-filesystem';
import { journalArtifactNames } from './sync-transaction-artifact-policy';
import { validatedTransactionArtifacts } from './sync-transaction-artifact-set';
import { inspectPinnedFile } from './sync-transaction-files';
import { validateOperationArtifact } from './sync-transaction-operation-artifact';
import {
  assertTransactionOwner,
  readTransactionOwner,
} from './sync-transaction-ownership';
import { resolveRemovalEntryName } from './sync-transaction-quarantine-read';
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
  expected?: import('./sync-node-identity').NodeIdentity,
): Promise<void> => {
  const state = await inspectPinnedFile(
    artifact(
      transaction,
      await resolveRemovalEntryName(transaction, name, expected),
    ),
  );
  if (
    state.contents === null ||
    state.mode !== PRIVATE_MODE ||
    !state.contents.equals(contents)
  ) {
    throw new Error(`Transaction artifact is invalid: ${name}`);
  }
};

const validateArtifact = async ({
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
  if (name === TRANSACTION_JOURNAL) {
    await assertExactArtifact(
      transaction,
      name,
      Buffer.from(`${JSON.stringify(journal)}\n`),
      expected,
    );
    return;
  }
  if (name === TRANSACTION_COMMITTED) {
    if (!committed) {
      throw new Error('Rolled-back transaction has a committed marker');
    }
    await assertExactArtifact(transaction, name, Buffer.alloc(0), expected);
    return;
  }
  if (name !== TRANSACTION_OWNER) {
    await validateOperationArtifact({
      committed,
      journal,
      name,
      expected,
      root,
      transaction,
    });
    return;
  }
  const owner = await readTransactionOwner(transaction, expected);
  assertTransactionOwner(owner, root.identity, transaction);
  if (owner.id !== journal.id) {
    throw new Error('Transaction owner does not match its journal');
  }
  const state = await inspectPinnedFile(
    artifact(
      transaction,
      await resolveRemovalEntryName(transaction, name, expected),
    ),
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
  const artifacts = await validatedTransactionArtifacts(
    transaction,
    journalArtifactNames(journal, committed),
  );
  await Promise.all(
    artifacts.map(({ expected, name }) =>
      validateArtifact({
        committed,
        expected,
        journal,
        name,
        root,
        transaction,
      }),
    ),
  );
};
