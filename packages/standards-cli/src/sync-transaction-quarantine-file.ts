import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import {
  identitiesMatch,
  identityOf,
  type NodeIdentity,
} from './sync-filesystem';
import { MAX_QUARANTINE_RECORD_BYTES } from './sync-transaction-quarantine-schema';

export const readQuarantineRecordHandle = async (handle: FileHandle) => {
  const info = await handle.stat({ bigint: true });
  if (!(info.isFile() && info.size <= BigInt(MAX_QUARANTINE_RECORD_BYTES))) {
    throw new Error('Quarantine ownership record must be a small regular file');
  }
  const contents = Buffer.alloc(Number(info.size));
  let offset = 0;
  while (offset < contents.byteLength) {
    // biome-ignore lint/performance/noAwaitInLoops: one descriptor is read sequentially into a bounded buffer.
    const read = await handle.read(
      contents,
      offset,
      contents.byteLength - offset,
      offset,
    );
    if (read.bytesRead === 0) {
      throw new Error('Quarantine ownership record ended unexpectedly');
    }
    offset += read.bytesRead;
  }
  return { contents: contents.toString('utf8'), identity: identityOf(info) };
};

export const readQuarantineRecordFile = async (
  directory: PinnedDirectory,
  name: string,
) => {
  const handle = await open(
    directoryEntryPath(directory, name),
    constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  );
  try {
    return await readQuarantineRecordHandle(handle);
  } finally {
    await handle.close();
  }
};

export const sameQuarantineRecord = (
  expected: { readonly contents: string; readonly identity: NodeIdentity },
  actual: { readonly contents: string; readonly identity: NodeIdentity },
): boolean =>
  identitiesMatch(expected.identity, actual.identity) &&
  expected.contents === actual.contents;
