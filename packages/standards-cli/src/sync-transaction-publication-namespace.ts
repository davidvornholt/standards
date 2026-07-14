import { readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import { TRANSACTION_PUBLICATION_PREFIX } from './sync-transaction-types';

export const stagedTransactionPublicationNames = async (
  root: PinnedDirectory,
): Promise<ReadonlyArray<string>> =>
  (await readdir(directoryEntryPath(root, '.'))).filter((entry) =>
    entry.startsWith(TRANSACTION_PUBLICATION_PREFIX),
  );

export const assertTransactionPublicationNamespaceAvailable = async (
  root: PinnedDirectory,
): Promise<void> => {
  if ((await stagedTransactionPublicationNames(root)).length > 0) {
    throw new Error('Transaction publication namespace is occupied');
  }
};
