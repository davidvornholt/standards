import { readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch } from './sync-filesystem';
import type { NodeIdentity } from './sync-node-identity';
import { isAtomicRecordTemporaryName } from './sync-transaction-artifact-names';
import { regularAtomicRecordIdentity } from './sync-transaction-atomic-record';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';
import {
  findRemovalBinding,
  inspectQuarantineEntry,
} from './sync-transaction-quarantine-read';
import { readQuarantineRecords } from './sync-transaction-quarantine-record';
import type { QuarantineRecord } from './sync-transaction-quarantine-schema';

const temporaryNames = async (
  directory: PinnedDirectory,
  finalName: string,
): Promise<ReadonlyArray<string>> =>
  (await readdir(directoryEntryPath(directory, '.')))
    .filter((name) => isAtomicRecordTemporaryName(name, finalName))
    .sort();

const retainedTailIsPending = async (
  directory: PinnedDirectory,
  name: string,
  identity: NodeIdentity,
  generations: ReadonlyArray<QuarantineRecord>,
): Promise<boolean> => {
  const matching = generations.filter((record) =>
    identitiesMatch(record.identity, identity),
  );
  if (matching.length === 0) {
    return false;
  }
  if (matching.length !== 1) {
    throw new Error(`Multiple quarantine records exist for ${name}`);
  }
  const bound = await inspectQuarantineEntry(
    directory,
    matching[0] as QuarantineRecord,
  );
  if (bound !== null) {
    throw new Error(
      `Atomic transaction record tail and binding both exist: ${name}`,
    );
  }
  return true;
};

const snapshotTails = async (
  directory: PinnedDirectory,
  finalName: string,
  expected?: NodeIdentity | null,
): Promise<ReadonlyMap<string, NodeIdentity>> => {
  const [rawNames, records] = await Promise.all([
    temporaryNames(directory, finalName),
    readQuarantineRecords(directory),
  ]);
  const retained = records.filter(({ original }) =>
    isAtomicRecordTemporaryName(original, finalName),
  );
  const names = [
    ...new Set([...rawNames, ...retained.map(({ original }) => original)]),
  ];
  const snapshots = await Promise.all(
    names.map(async (name) => {
      const generations = retained.filter((record) => record.original === name);
      const binding =
        expected === undefined || expected === null
          ? null
          : await findRemovalBinding(directory, name, expected);
      if (binding !== null) {
        return [name, binding.identity] as const;
      }
      if (!rawNames.includes(name)) {
        return null;
      }
      const identity = await regularAtomicRecordIdentity(directory, name);
      if (
        generations.length > 0 &&
        expected === undefined &&
        !(await retainedTailIsPending(directory, name, identity, generations))
      ) {
        return null;
      }
      if (
        expected !== undefined &&
        expected !== null &&
        !identitiesMatch(identity, expected)
      ) {
        throw new Error(
          `Atomic transaction record tail changed after binding: ${name}`,
        );
      }
      return [name, identity] as const;
    }),
  );
  return new Map(snapshots.filter((entry) => entry !== null));
};

const removeNames = async (
  directory: PinnedDirectory,
  entries: ReadonlyMap<string, NodeIdentity>,
): Promise<void> => {
  for (const [name, expected] of entries) {
    // biome-ignore lint/performance/noAwaitInLoops: atomic tails are bound and removed sequentially
    await bindAndRemoveEntry({
      directory,
      expected,
      kind: 'file',
      name,
    });
  }
};

export const recoverAtomicPublicationTails = async (
  directory: PinnedDirectory,
  finalName: string,
  mutate = true,
): Promise<void> => {
  const tails = await snapshotTails(directory, finalName);
  if (!mutate && tails.size > 0) {
    throw new Error('Pending atomic transaction record cleanup');
  }
  await removeNames(directory, tails);
};

export const assertNoUnboundAtomicPublicationTails = async (
  directory: PinnedDirectory,
  finalName: string,
): Promise<void> => {
  const tails = await snapshotTails(directory, finalName);
  if (tails.size > 0) {
    throw new Error(
      `Unbound atomic transaction record tail was preserved: ${[...tails.keys()].join(', ')}`,
    );
  }
};

export const removeBoundAtomicPartialTails = async (
  directory: PinnedDirectory,
  finalName: string,
  expected?: NodeIdentity | null,
): Promise<void> => {
  const tails = await snapshotTails(directory, finalName, expected);
  if (tails.size === 0) {
    return;
  }
  if (expected === undefined) {
    await removeNames(directory, tails);
    return;
  }
  if (tails.size !== 1 || expected === null) {
    throw new Error('Atomic transaction record tail lacks an inode binding');
  }
  const identity = tails.values().next().value;
  if (identity === undefined || !identitiesMatch(identity, expected)) {
    throw new Error('Atomic transaction record tail changed after binding');
  }
  await removeNames(directory, tails);
};
