import { readdir, unlink } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import { isAtomicRecordTemporaryName } from './sync-transaction-artifact-names';
import { regularAtomicRecordIdentity } from './sync-transaction-atomic-record';

const temporaryNames = async (
  directory: PinnedDirectory,
  finalName: string,
): Promise<ReadonlyArray<string>> =>
  (await readdir(directoryEntryPath(directory, '.')))
    .filter((name) => isAtomicRecordTemporaryName(name, finalName))
    .sort();

const snapshotTails = async (
  directory: PinnedDirectory,
  finalName: string,
): Promise<ReadonlyMap<string, NodeIdentity>> =>
  new Map(
    await Promise.all(
      (await temporaryNames(directory, finalName)).map(
        async (name) =>
          [name, await regularAtomicRecordIdentity(directory, name)] as const,
      ),
    ),
  );

const removeNames = async (
  directory: PinnedDirectory,
  entries: ReadonlyMap<string, NodeIdentity>,
): Promise<void> => {
  for (const [name, expected] of entries) {
    // biome-ignore lint/performance/noAwaitInLoops: every removal is preceded by an identity recheck
    const current = await regularAtomicRecordIdentity(directory, name);
    if (!identitiesMatch(expected, current)) {
      throw new Error(`Atomic transaction record tail changed: ${name}`);
    }
    await unlink(directoryEntryPath(directory, name));
  }
  if (entries.size > 0) {
    await syncPinnedDirectory(directory);
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

export const removeBoundAtomicPartialTails = async (
  directory: PinnedDirectory,
  finalName: string,
): Promise<void> =>
  removeNames(directory, await snapshotTails(directory, finalName));
