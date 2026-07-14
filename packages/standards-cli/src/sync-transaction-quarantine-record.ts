import { readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import {
  readQuarantineRecordFile,
  sameQuarantineRecord,
} from './sync-transaction-quarantine-file';
import {
  isQuarantineArtifactName,
  parseQuarantineRecord,
  type QuarantineRecord,
  quarantineRecordNames,
  quarantineRecordTokenFromName,
  REMOVAL_BINDING_PREFIX,
} from './sync-transaction-quarantine-schema';

export const readQuarantineRecords = async (
  directory: PinnedDirectory,
): Promise<ReadonlyArray<QuarantineRecord>> => {
  const entries = await readdir(directoryEntryPath(directory, '.'));
  const malformed = entries.filter(
    (name) =>
      name.startsWith(REMOVAL_BINDING_PREFIX) &&
      !isQuarantineArtifactName(name),
  );
  if (malformed.length > 0) {
    throw new Error(`Invalid quarantine artifacts: ${malformed.join(', ')}`);
  }
  const tokens = new Set(
    entries.flatMap((name) => {
      const token = quarantineRecordTokenFromName(name);
      return token === null ? [] : [token];
    }),
  );
  return Promise.all(
    [...tokens].map(async (token) => {
      const pair = quarantineRecordNames(token);
      if (!entries.includes(pair.tail)) {
        throw new Error('Quarantine ownership record publication changed');
      }
      const tail = await readQuarantineRecordFile(directory, pair.tail);
      if (entries.includes(pair.record)) {
        const record = await readQuarantineRecordFile(directory, pair.record);
        if (!sameQuarantineRecord(tail, record)) {
          throw new Error('Quarantine ownership record publication changed');
        }
      }
      return parseQuarantineRecord(tail.contents, token);
    }),
  );
};
