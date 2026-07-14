import {
  type PinnedDirectory,
  syncPinnedDirectory,
} from './sync-directory-handles';
import { identitiesMatch, type NodeIdentity } from './sync-filesystem';
import { renameNoReplace } from './sync-linux-rename';
import { publishQuarantineRecord } from './sync-transaction-quarantine-publication';
import { inspectQuarantineEntry } from './sync-transaction-quarantine-read';
import {
  type QuarantineRecord,
  quarantineEntryName,
  quarantineToken,
  REMOVAL_BINDING_PREFIX,
} from './sync-transaction-quarantine-schema';

export const removalBindingName = (
  name: string,
  identity: NodeIdentity,
  kind: QuarantineRecord['kind'] = 'file',
): string =>
  `${REMOVAL_BINDING_PREFIX}${quarantineToken(name, identity, kind)}.entry`;

export const bindAndRemoveEntry = async ({
  afterBind,
  afterRecordPartialWrite,
  afterRemove,
  afterRecordSync,
  beforeBind,
  validateBound,
  directory,
  expected,
  kind,
  name,
  sourceDirectory = directory,
  sourceName = name,
}: {
  readonly afterBind?: () => Promise<void>;
  readonly afterRecordPartialWrite?: () => Promise<void>;
  readonly afterRemove?: () => Promise<void>;
  readonly afterRecordSync?: () => Promise<void>;
  readonly beforeBind?: () => Promise<void>;
  readonly directory: PinnedDirectory;
  readonly expected: NodeIdentity;
  readonly kind: QuarantineRecord['kind'];
  readonly name: string;
  readonly sourceDirectory?: PinnedDirectory;
  readonly sourceName?: string;
  readonly validateBound?: () => Promise<void>;
}): Promise<void> => {
  const record = await publishQuarantineRecord({
    directory,
    hooks: {
      afterPartialWrite: afterRecordPartialWrite,
      afterTailSync: afterRecordSync,
    },
    identity: expected,
    kind,
    original: name,
  });
  const boundName = quarantineEntryName(record);
  const existing = await inspectQuarantineEntry(directory, record, false);
  if (existing === null) {
    await beforeBind?.();
    renameNoReplace(
      sourceDirectory.handle.fd,
      sourceName,
      directory.handle.fd,
      boundName,
    );
    await afterBind?.();
  }
  const bound = await inspectQuarantineEntry(directory, record, false);
  if (!identitiesMatch(expected, bound)) {
    if (bound !== null) {
      try {
        renameNoReplace(
          directory.handle.fd,
          boundName,
          sourceDirectory.handle.fd,
          sourceName,
        );
      } catch {
        // Both entries are retained when a public replacement already exists.
      }
    }
    throw new Error(`Removal target changed before quarantine: ${name}`);
  }
  try {
    await validateBound?.();
  } catch (error) {
    try {
      renameNoReplace(
        directory.handle.fd,
        boundName,
        sourceDirectory.handle.fd,
        sourceName,
      );
    } catch {
      // Preserve the quarantined entry when its public name was replaced.
    }
    throw error;
  }
  await syncPinnedDirectory(directory);
  await afterRemove?.();
};
