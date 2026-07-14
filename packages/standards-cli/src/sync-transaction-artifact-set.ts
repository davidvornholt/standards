import { readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
  type PinnedTarget,
} from './sync-directory-handles';
import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import { isAtomicRecordTemporaryName } from './sync-transaction-artifact-names';
import { inspectPinnedFile } from './sync-transaction-files';
import {
  findRemovalBinding,
  inspectQuarantineSource,
  resolveRemovalEntryName,
} from './sync-transaction-quarantine-read';
import { readQuarantineRecords } from './sync-transaction-quarantine-record';
import {
  isQuarantineDraftName,
  type QuarantineRecord,
  quarantineArtifactNames,
} from './sync-transaction-quarantine-schema';
import {
  TRANSACTION_JOURNAL,
  TRANSACTION_JOURNAL_TEMP,
} from './sync-transaction-types';

const artifact = (
  transaction: PinnedDirectory,
  name: string,
): PinnedTarget => ({ name, parent: transaction, rel: name });

const publicationFinalName = (
  record: QuarantineRecord,
  allowed: ReadonlySet<string>,
): string | undefined => {
  if (
    record.original === TRANSACTION_JOURNAL_TEMP &&
    allowed.has(TRANSACTION_JOURNAL)
  ) {
    return TRANSACTION_JOURNAL;
  }
  return [...allowed].find((name) =>
    isAtomicRecordTemporaryName(record.original, name),
  );
};

const validateQuarantine = async (
  transaction: PinnedDirectory,
  record: QuarantineRecord,
  allowed: ReadonlySet<string>,
): Promise<{
  readonly consumesPublic: boolean;
  readonly expected: NodeIdentity;
  readonly name: string;
} | null> => {
  const binding = await findRemovalBinding(
    transaction,
    record.original,
    record.identity,
  );
  if (binding === null) {
    const source = await inspectQuarantineSource(transaction, record);
    if (!identitiesMatch(source, record.identity)) {
      throw new Error(
        `Transaction quarantine intent is not resumable: ${record.original}`,
      );
    }
    return allowed.has(record.original)
      ? {
          consumesPublic: true,
          expected: record.identity,
          name: record.original,
        }
      : null;
  }
  if (allowed.has(record.original)) {
    return {
      consumesPublic: false,
      expected: record.identity,
      name: record.original,
    };
  }
  const finalName = publicationFinalName(record, allowed);
  if (finalName === undefined) {
    throw new Error(`Transaction quarantine is unexpected: ${record.original}`);
  }
  const finalState = await inspectPinnedFile(
    artifact(
      transaction,
      await resolveRemovalEntryName(transaction, finalName, binding.identity),
    ),
  );
  if (!identitiesMatch(binding.identity, finalState.identity)) {
    throw new Error(
      `Transaction publication tail is invalid: ${record.original}`,
    );
  }
  return null;
};

export type ValidatedTransactionArtifact = {
  readonly expected?: NodeIdentity;
  readonly name: string;
};

export const validatedTransactionArtifacts = async (
  transaction: PinnedDirectory,
  allowed: ReadonlySet<string>,
): Promise<ReadonlyArray<ValidatedTransactionArtifact>> => {
  const entries = await readdir(directoryEntryPath(transaction, '.'));
  const records = await readQuarantineRecords(transaction);
  const physical = new Set(records.flatMap(quarantineArtifactNames));
  for (const entry of entries.filter(isQuarantineDraftName)) {
    physical.add(entry);
  }
  const unexpected = entries.find(
    (entry) =>
      !(allowed.has(entry) || physical.has(entry)) &&
      entry !== TRANSACTION_JOURNAL_TEMP,
  );
  if (unexpected !== undefined) {
    throw new Error(`Transaction artifact is unexpected: ${unexpected}`);
  }
  if (entries.includes(TRANSACTION_JOURNAL_TEMP)) {
    const [tail, journal] = await Promise.all([
      inspectPinnedFile(artifact(transaction, TRANSACTION_JOURNAL_TEMP)),
      inspectPinnedFile(artifact(transaction, TRANSACTION_JOURNAL)),
    ]);
    if (!identitiesMatch(tail.identity, journal.identity)) {
      throw new Error('Transaction journal publication tail is invalid');
    }
  }
  const logical = await Promise.all(
    records.map((record) => validateQuarantine(transaction, record, allowed)),
  );
  const retained = logical.filter((candidate) => candidate !== null);
  const consumedPublic = new Set(
    retained
      .filter(({ consumesPublic }) => consumesPublic)
      .map(({ name }) => name),
  );
  return [
    ...entries
      .filter((entry) => allowed.has(entry) && !consumedPublic.has(entry))
      .map((name) => ({ name })),
    ...retained.map(({ expected, name }) => ({ expected, name })),
  ];
};
