import { readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import { isAtomicRecordTemporaryName } from './sync-transaction-artifact-names';
import { regularAtomicRecordIdentity } from './sync-transaction-atomic-record';
import {
  bindAndRemoveEntry,
  parseRemovalBinding,
} from './sync-transaction-bound-remove';

const temporaryNames = async (
  directory: PinnedDirectory,
  finalName: string,
): Promise<ReadonlyArray<string>> =>
  (await readdir(directoryEntryPath(directory, '.')))
    .map((name) => {
      const binding = parseRemovalBinding(name);
      return binding === null ? name : binding.original;
    })
    .filter((name) => isAtomicRecordTemporaryName(name, finalName))
    .sort();

const snapshotTails = async (
  directory: PinnedDirectory,
  finalName: string,
): Promise<ReadonlyMap<string, NodeIdentity>> => {
  const names = await temporaryNames(directory, finalName);
  if (new Set(names).size !== names.length) {
    throw new Error('Atomic transaction record tail and binding both exist');
  }
  const entries = await readdir(directoryEntryPath(directory, '.'));
  return new Map(
    await Promise.all(
      names.map(async (name) => {
        const binding = entries.find(
          (entry) => parseRemovalBinding(entry)?.original === name,
        );
        const actual = binding ?? name;
        const identity = await regularAtomicRecordIdentity(directory, actual);
        const encoded =
          binding === undefined ? null : parseRemovalBinding(binding);
        if (encoded !== null && !identitiesMatch(encoded.identity, identity)) {
          throw new Error(
            `Atomic transaction record removal binding changed: ${name}`,
          );
        }
        return [name, identity] as const;
      }),
    ),
  );
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
  const tails = await snapshotTails(directory, finalName);
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
