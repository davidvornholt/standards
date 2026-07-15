import { createHash } from 'node:crypto';
import {
  MAX_FILESYSTEM_IDENTITY,
  type NodeIdentity,
  parseStoredNodeIdentity,
  storedNodeIdentity,
} from './sync-node-identity';
import { REMOVAL_BINDING_PREFIX as TRANSACTION_REMOVAL_BINDING_PREFIX } from './sync-transaction-namespace';

export const REMOVAL_BINDING_PREFIX = TRANSACTION_REMOVAL_BINDING_PREFIX;
const VERSION = 1;
const TOKEN_LENGTH = 64;
const NAME_MAX = 255;
const TOKEN = /^[0-9a-f]{64}$/u;
const ARTIFACT_SUFFIXES = ['.entry', '.json', '.tail'] as const;
const DRAFT_SUFFIX =
  /^\.draft\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type QuarantineRecord = {
  readonly identity: NodeIdentity;
  readonly kind: 'directory' | 'file';
  readonly original: string;
  readonly token: string;
};

export const quarantineRecordNames = (token: string) => ({
  entry: `${REMOVAL_BINDING_PREFIX}${token}.entry`,
  record: `${REMOVAL_BINDING_PREFIX}${token}.json`,
  tail: `${REMOVAL_BINDING_PREFIX}${token}.tail`,
});

export const quarantineDraftName = (token: string, id: string): string =>
  `${REMOVAL_BINDING_PREFIX}${token}.draft.${id}`;

export const quarantineArtifactNames = (
  record: QuarantineRecord,
): ReadonlyArray<string> => Object.values(quarantineRecordNames(record.token));

const artifactParts = (
  name: string,
): { readonly suffix: string; readonly token: string } | null => {
  if (!name.startsWith(REMOVAL_BINDING_PREFIX)) {
    return null;
  }
  const value = name.slice(REMOVAL_BINDING_PREFIX.length);
  const token = value.slice(0, TOKEN_LENGTH);
  const suffix = value.slice(TOKEN_LENGTH);
  return TOKEN.test(token) &&
    (ARTIFACT_SUFFIXES.includes(suffix as never) || DRAFT_SUFFIX.test(suffix))
    ? { suffix, token }
    : null;
};

export const isQuarantineArtifactName = (name: string): boolean =>
  artifactParts(name) !== null;

export const isQuarantineDraftName = (name: string): boolean => {
  const parts = artifactParts(name);
  return parts === null ? false : parts.suffix.startsWith('.draft.');
};

export const quarantineArtifactTokenFromName = (
  name: string,
): string | null => {
  const parts = artifactParts(name);
  return parts === null ? null : parts.token;
};

export const quarantineRecordTokenFromName = (name: string): string | null => {
  const parts = artifactParts(name);
  return parts !== null && ['.json', '.tail'].includes(parts.suffix)
    ? parts.token
    : null;
};

export const quarantineToken = (
  original: string,
  identity: NodeIdentity,
  kind: QuarantineRecord['kind'],
): string =>
  createHash('sha256')
    .update(
      `${VERSION}\0${kind}\0${original}\0${identity.dev}\0${identity.ino}`,
    )
    .digest('hex');

export const quarantineRecordContents = (record: QuarantineRecord): string =>
  `${JSON.stringify({
    identity: storedNodeIdentity(record.identity),
    kind: record.kind,
    original: record.original,
    version: VERSION,
  })}\n`;

export const MAX_QUARANTINE_RECORD_BYTES = Buffer.byteLength(
  quarantineRecordContents({
    identity: {
      dev: MAX_FILESYSTEM_IDENTITY,
      ino: MAX_FILESYSTEM_IDENTITY,
    },
    kind: 'directory',
    original: '\u0001'.repeat(NAME_MAX),
    token: '',
  }),
);

const validOriginal = (original: string): boolean =>
  original.length > 0 &&
  !original.includes('/') &&
  !original.includes('\0') &&
  Buffer.byteLength(original) <= NAME_MAX;

export const assertValidQuarantineOriginal = (original: string): void => {
  if (!validOriginal(original)) {
    throw new Error('Quarantine original name is invalid');
  }
};

export const parseQuarantineRecord = (
  contents: string,
  token: string,
): QuarantineRecord => {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error('Quarantine ownership record is invalid', { cause: error });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Quarantine ownership record is invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'identity,kind,original,version' ||
    record.version !== VERSION ||
    (record.kind !== 'file' && record.kind !== 'directory') ||
    typeof record.original !== 'string' ||
    !validOriginal(record.original)
  ) {
    throw new Error('Quarantine ownership record is invalid');
  }
  const parsed = {
    identity: parseStoredNodeIdentity(record.identity, 'quarantine identity'),
    kind: record.kind,
    original: record.original,
    token,
  } as const;
  if (
    quarantineToken(parsed.original, parsed.identity, parsed.kind) !== token
  ) {
    throw new Error('Quarantine ownership record token is invalid');
  }
  return parsed;
};

export const quarantineEntryName = (record: QuarantineRecord): string =>
  quarantineRecordNames(record.token).entry;
