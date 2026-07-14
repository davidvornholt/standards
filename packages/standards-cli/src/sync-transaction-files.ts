import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
  type PinnedTarget,
  syncPinnedDirectory,
} from './sync-directory-handles';
import {
  type FileState,
  identitiesMatch,
  identityOf,
  type NodeIdentity,
} from './sync-filesystem';
import {
  type ExpectedFile,
  effectiveMode,
  hashContents,
  type MutationFault,
  type TransactionJournal,
} from './sync-transaction-types';

export type { FileOperation, MutationFault } from './sync-transaction-types';

export type TransactionWrite = {
  readonly before: FileState;
  readonly contents: Buffer;
  readonly mode: number | null;
  readonly rel: string;
};

export type StagedWrite = {
  readonly name: string;
  readonly write: TransactionWrite;
};

const FILE_TYPE_MODE_BASE = 0o1000;

const isMissing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

const statesMatch = (left: FileState, right: FileState): boolean =>
  identitiesMatch(left.identity, right.identity) &&
  left.mode === right.mode &&
  (left.contents === right.contents ||
    (left.contents !== null &&
      right.contents !== null &&
      left.contents.equals(right.contents)));

export const inspectPinnedFile = async (
  target: PinnedTarget,
): Promise<FileState> => {
  let handle: FileHandle;
  try {
    handle = await open(
      directoryEntryPath(target.parent, target.name),
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isMissing(error)) {
      return { contents: null, identity: null, mode: null };
    }
    throw error;
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) {
      throw new Error(`Mutation target must be a regular file: ${target.rel}`);
    }
    return {
      contents: await handle.readFile(),
      identity: identityOf(info),
      mode: Number(info.mode) % FILE_TYPE_MODE_BASE,
    };
  } finally {
    await handle.close();
  }
};

export const assertPinnedFileUnchanged = async (
  target: PinnedTarget,
  before: FileState,
): Promise<void> => {
  if (!statesMatch(before, await inspectPinnedFile(target))) {
    throw new Error(`Consumer file changed after preflight: ${target.rel}`);
  }
};

export const fileMatchesExpected = (
  state: FileState,
  expected: ExpectedFile,
): boolean =>
  state.mode === expected.mode &&
  (state.contents === null
    ? expected.hash === null && expected.dev === null && expected.ino === null
    : expected.hash === hashContents(state.contents) &&
      state.identity !== null &&
      String(state.identity.dev) === expected.dev &&
      String(state.identity.ino) === expected.ino);

export const fileMatchesDesired = (
  state: FileState,
  desired: { readonly hash: string; readonly mode: number },
): boolean =>
  state.contents !== null &&
  state.mode === desired.mode &&
  hashContents(state.contents) === desired.hash;

export const assertPinnedFileExpected = async (
  target: PinnedTarget,
  expected: ExpectedFile,
): Promise<void> => {
  if (!fileMatchesExpected(await inspectPinnedFile(target), expected)) {
    throw new Error(`Consumer file changed after preflight: ${target.rel}`);
  }
};

export const assertPinnedDirectoryUnchanged = async (
  directory: PinnedDirectory,
  before: NodeIdentity,
  rel: string,
): Promise<void> => {
  const info = await directory.handle.stat({ bigint: true });
  if (!(info.isDirectory() && identitiesMatch(before, identityOf(info)))) {
    throw new Error(`Consumer directory changed after preflight: ${rel}`);
  }
};

const stageWrite = async (
  transaction: PinnedDirectory,
  write: TransactionWrite,
  name: string,
  fault: MutationFault,
): Promise<StagedWrite> => {
  const handle = await open(
    directoryEntryPath(transaction, name),
    constants.O_CREAT +
      constants.O_EXCL +
      constants.O_WRONLY +
      constants.O_NOFOLLOW,
    effectiveMode(write.mode),
  );
  let closed = false;
  try {
    await handle.writeFile(write.contents);
    await fault('write', write.rel);
    await handle.chmod(effectiveMode(write.mode));
    await handle.sync();
    await fault('fsync', write.rel);
    await handle.close();
    closed = true;
    await fault('close', write.rel);
    return { name, write };
  } catch (error) {
    if (!closed) {
      await handle.close().catch(() => undefined);
    }
    throw error;
  }
};

export const stageWrites = async (
  transaction: PinnedDirectory,
  writes: ReadonlyArray<TransactionWrite>,
  fault: MutationFault,
  journal?: TransactionJournal,
): Promise<ReadonlyArray<StagedWrite>> => {
  const results = await Promise.allSettled(
    writes.map((write, index) => {
      const name =
        journal?.operations.find(({ rel }) => rel === write.rel)?.stage ??
        `write-${index}`;
      if (name === null) {
        throw new Error(`Missing staged artifact for write: ${write.rel}`);
      }
      return stageWrite(transaction, write, name, fault);
    }),
  );
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  const [singleFailure] = failures;
  if (failures.length === 1 && singleFailure !== undefined) {
    throw singleFailure.reason;
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ reason }) => reason as unknown),
      'Could not stage standards filesystem transaction',
    );
  }
  await syncPinnedDirectory(transaction);
  return results.map(
    (result) => (result as PromiseFulfilledResult<StagedWrite>).value,
  );
};
