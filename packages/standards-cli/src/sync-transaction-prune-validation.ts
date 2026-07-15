import { readdir } from 'node:fs/promises';
import {
  directoryEntryPath,
  type PinnedDirectory,
} from './sync-directory-handles';
import {
  readQuarantineRecordFile,
  sameQuarantineRecord,
} from './sync-transaction-quarantine-file';
import { inspectQuarantineEntry } from './sync-transaction-quarantine-read';
import { readQuarantineRecords } from './sync-transaction-quarantine-record';
import {
  isQuarantineArtifactName,
  isQuarantineDraftName,
  quarantineArtifactNames,
  quarantineArtifactTokenFromName,
  quarantineRecordNames,
} from './sync-transaction-quarantine-schema';

const notEmpty = (cause?: unknown): Error =>
  new Error('Prune target is not empty', { cause });

const assertDraftOwned = async (
  directory: PinnedDirectory,
  name: string,
  recordTokens: ReadonlySet<string>,
): Promise<void> => {
  const token = quarantineArtifactTokenFromName(name);
  if (token === null || !recordTokens.has(token)) {
    throw new Error('Prune target contains an orphan quarantine draft');
  }
  const [draft, tail] = await Promise.all([
    readQuarantineRecordFile(directory, name),
    readQuarantineRecordFile(directory, quarantineRecordNames(token).tail),
  ]);
  if (!sameQuarantineRecord(tail, draft)) {
    throw new Error('Prune target quarantine draft changed');
  }
};

export const assertPruneTargetDirectlyEmpty = async (
  directory: PinnedDirectory,
): Promise<void> => {
  const entries = await readdir(directoryEntryPath(directory, '.'));
  if (entries.length === 0) {
    return;
  }
  try {
    if (entries.some((entry) => !isQuarantineArtifactName(entry))) {
      throw new Error('Prune target contains a repository-owned entry');
    }
    const records = await readQuarantineRecords(directory);
    const physical = new Set(records.flatMap(quarantineArtifactNames));
    const recordTokens = new Set(records.map(({ token }) => token));
    for (const record of records) {
      const { entry } = quarantineRecordNames(record.token);
      if (
        entries.includes(entry) &&
        // biome-ignore lint/performance/noAwaitInLoops: every retained generation must be validated before pruning its parent.
        (await inspectQuarantineEntry(directory, record)) === null
      ) {
        throw new Error('Prune target quarantine entry disappeared');
      }
    }
    for (const draft of entries.filter(isQuarantineDraftName)) {
      // biome-ignore lint/performance/noAwaitInLoops: drafts are validated against their own durable record generation.
      await assertDraftOwned(directory, draft, recordTokens);
      physical.add(draft);
    }
    if (entries.some((entry) => !physical.has(entry))) {
      throw new Error('Prune target contains unowned quarantine artifacts');
    }
  } catch (error) {
    throw notEmpty(error);
  }
};
