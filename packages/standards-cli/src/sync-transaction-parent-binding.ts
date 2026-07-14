import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import { publishAtomicTransactionRecord } from './sync-transaction-atomic-record';
import { removeBoundAtomicPartialTails } from './sync-transaction-atomic-recovery';
import { resolveRemovalEntryName } from './sync-transaction-quarantine-read';
import {
  reservationIdentity,
  storedIdentity,
} from './sync-transaction-reservation-record';
import {
  TRANSACTION_PARENT_BINDING_PREFIX,
  type TransactionJournal,
} from './sync-transaction-types';

const MAX_BYTES = 8192;
const VERSION = 1;
const missing = (error: unknown): boolean =>
  (error as { readonly code?: unknown }).code === 'ENOENT';

export type CreatedParentBinding = {
  readonly file: NodeIdentity;
  readonly id: string;
  readonly index: number;
  readonly parent: NodeIdentity;
  readonly rel: string;
  readonly root: NodeIdentity;
};

export const createdParentBindingName = (id: string, index: number): string =>
  `${TRANSACTION_PARENT_BINDING_PREFIX}${id}-${index}`;

export const assertParentBindingNamespaceAvailable = async (
  root: PinnedDirectory,
): Promise<void> => {
  const entries = (await readdir(directoryEntryPath(root, '.'))).filter(
    (entry) => entry.startsWith(TRANSACTION_PARENT_BINDING_PREFIX),
  );
  if (entries.length > 0) {
    throw new Error('Created-parent binding namespace is occupied');
  }
};

const parseBinding = (
  contents: string,
  file: NodeIdentity,
): CreatedParentBinding => {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error('Created-parent binding is invalid', { cause: error });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Created-parent binding is invalid');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(',') !== 'id,index,parent,rel,root,version' ||
    record.version !== VERSION ||
    typeof record.id !== 'string' ||
    !Number.isSafeInteger(record.index) ||
    Number(record.index) < 0 ||
    typeof record.rel !== 'string'
  ) {
    throw new Error('Created-parent binding is invalid');
  }
  return {
    file,
    id: record.id,
    index: Number(record.index),
    parent: reservationIdentity(record.parent, 'created parent'),
    rel: record.rel,
    root: reservationIdentity(record.root, 'root'),
  };
};

const readBinding = async (
  root: PinnedDirectory,
  name: string,
): Promise<CreatedParentBinding | null> => {
  await removeBoundAtomicPartialTails(root, name);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      directoryEntryPath(root, await resolveRemovalEntryName(root, name)),
      constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
    );
  } catch (error) {
    if (missing(error)) {
      return null;
    }
    throw error;
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!(info.isFile() && info.size <= BigInt(MAX_BYTES))) {
      throw new Error('Created-parent binding must be a small regular file');
    }
    return parseBinding(await handle.readFile('utf8'), {
      dev: info.dev,
      ino: info.ino,
    });
  } finally {
    await handle.close();
  }
};

export const createParentBinding = async ({
  afterSync,
  index,
  journal,
  parent,
  root,
}: {
  readonly afterSync?: () => Promise<void>;
  readonly index: number;
  readonly journal: TransactionJournal;
  readonly parent: PinnedDirectory;
  readonly root: PinnedDirectory;
}): Promise<void> => {
  const rel = journal.createdParents[index];
  if (rel === undefined) {
    throw new Error('Created-parent binding index is invalid');
  }
  await publishAtomicTransactionRecord({
    afterFinalSync: afterSync,
    contents: `${JSON.stringify({
      id: journal.id,
      index,
      parent: storedIdentity(parent.identity),
      rel,
      root: storedIdentity(root.identity),
      version: VERSION,
    })}\n`,
    directory: root,
    finalName: createdParentBindingName(journal.id, index),
    maximumBytes: MAX_BYTES,
  });
};

export const readParentBinding = async (
  root: PinnedDirectory,
  journal: TransactionJournal,
  index: number,
): Promise<CreatedParentBinding | null> => {
  const binding = await readBinding(
    root,
    createdParentBindingName(journal.id, index),
  );
  if (binding === null) {
    return null;
  }
  const rel = journal.createdParents[index];
  if (
    rel === undefined ||
    binding.id !== journal.id ||
    binding.index !== index ||
    binding.rel !== rel ||
    !identitiesMatch(binding.root, root.identity)
  ) {
    throw new Error('Created-parent binding does not match its journal');
  }
  return binding;
};
