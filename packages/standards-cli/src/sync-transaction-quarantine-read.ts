import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  directoryEntryPath,
  openPinnedChild,
  type PinnedDirectory,
} from './sync-directory-handles';
import {
  identitiesMatch,
  identityOf,
  type NodeIdentity,
} from './sync-filesystem';
import { isMissingFilesystemError } from './sync-filesystem-error';
import { readQuarantineRecords } from './sync-transaction-quarantine-record';
import {
  type QuarantineRecord,
  quarantineEntryName,
} from './sync-transaction-quarantine-schema';

const inspectNamedEntry = async (
  directory: PinnedDirectory,
  record: QuarantineRecord,
  name: string,
  validateIdentity = true,
): Promise<NodeIdentity | null> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      directoryEntryPath(directory, name),
      constants.O_RDONLY +
        constants.O_NOFOLLOW +
        constants.O_NONBLOCK +
        (record.kind === 'directory' ? constants.O_DIRECTORY : 0),
    );
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      return null;
    }
    throw error;
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (
      (record.kind === 'file' && !info.isFile()) ||
      (record.kind === 'directory' && !info.isDirectory())
    ) {
      throw new Error(`Quarantine entry changed kind: ${record.original}`);
    }
    const identity = identityOf(info);
    if (validateIdentity && !identitiesMatch(record.identity, identity)) {
      throw new Error(`Quarantine entry changed: ${record.original}`);
    }
    return identity;
  } finally {
    await handle.close();
  }
};

export const inspectQuarantineEntry = async (
  directory: PinnedDirectory,
  record: QuarantineRecord,
  validateIdentity = true,
): Promise<NodeIdentity | null> =>
  inspectNamedEntry(
    directory,
    record,
    quarantineEntryName(record),
    validateIdentity,
  );

export const inspectQuarantineSource = async (
  directory: PinnedDirectory,
  record: QuarantineRecord,
): Promise<NodeIdentity | null> =>
  inspectNamedEntry(directory, record, record.original, false);

export const findRemovalBinding = async (
  directory: PinnedDirectory,
  name: string,
  expected?: NodeIdentity,
): Promise<{
  readonly identity: NodeIdentity;
  readonly kind: QuarantineRecord['kind'];
  readonly name: string;
} | null> => {
  const records = (await readQuarantineRecords(directory)).filter(
    (candidate) =>
      candidate.original === name &&
      (expected === undefined || identitiesMatch(candidate.identity, expected)),
  );
  if (records.length === 0) {
    return null;
  }
  if (records.length !== 1) {
    throw new Error(`Multiple quarantine records exist for ${name}`);
  }
  const record = records[0] as QuarantineRecord;
  const identity = await inspectQuarantineEntry(directory, record);
  return identity === null
    ? null
    : { identity, kind: record.kind, name: quarantineEntryName(record) };
};

export const resolveRemovalEntryName = async (
  directory: PinnedDirectory,
  name: string,
  expected?: NodeIdentity,
): Promise<string> => {
  try {
    const publicEntry = await open(
      directoryEntryPath(directory, name),
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
    );
    const info = await publicEntry.stat({ bigint: true });
    await publicEntry.close();
    if (expected === undefined || identitiesMatch(expected, identityOf(info))) {
      return name;
    }
  } catch (error) {
    if (!isMissingFilesystemError(error)) {
      throw error;
    }
  }
  try {
    return (await findRemovalBinding(directory, name, expected))?.name ?? name;
  } catch (error) {
    if (String(error).includes('Multiple quarantine records')) {
      return name;
    }
    throw error;
  }
};

export const openRemovalBindingDirectory = async (
  directory: PinnedDirectory,
  name: string,
  expected?: NodeIdentity,
): Promise<PinnedDirectory | null> => {
  const binding = await findRemovalBinding(directory, name, expected);
  if (binding === null) {
    return null;
  }
  if (binding.kind !== 'directory') {
    throw new Error(`Quarantine entry is not a directory: ${name}`);
  }
  const opened = await openPinnedChild(directory, binding.name);
  if (!identitiesMatch(binding.identity, opened.identity)) {
    await opened.handle.close();
    throw new Error(`Quarantine directory changed: ${name}`);
  }
  return opened;
};
