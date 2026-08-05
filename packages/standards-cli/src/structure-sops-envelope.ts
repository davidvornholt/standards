import { isRecord } from './github-settings-parse';

const SOPS_ENVELOPE =
  /^ENC\[AES256_GCM,data:(?<data>[A-Za-z0-9+/]+={0,2}),iv:(?<iv>[A-Za-z0-9+/]+={0,2}),tag:(?<tag>[A-Za-z0-9+/]+={0,2}),type:(?<type>bool|bytes|comment|float|int|str)\]$/u;
const SOPS_VERSION = /^\d+\.\d+\.\d+$/u;
const SOPS_SOURCE_CONTRACTS = [
  ['age', ['recipient', 'enc']],
  ['azure_kv', ['vault_url', 'name', 'version', 'created_at', 'enc']],
  ['gcp_kms', ['resource_id', 'created_at', 'enc']],
  [
    'hc_vault',
    ['vault_address', 'engine_path', 'key_name', 'created_at', 'enc'],
  ],
  ['kms', ['arn', 'created_at', 'enc']],
  ['pgp', ['created_at', 'enc', 'fp']],
] as const;
type SopsSource = (typeof SOPS_SOURCE_CONTRACTS)[number][0];
const SOPS_SOURCES = SOPS_SOURCE_CONTRACTS.map(([source]) => source);
const SOPS_SOURCE_FIELDS = new Map<SopsSource, ReadonlyArray<string>>(
  SOPS_SOURCE_CONTRACTS,
);

const isCanonicalBase64 = (value: string): boolean => {
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
};

const sopsEnvelopeType = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const match = SOPS_ENVELOPE.exec(value);
  const groups = match?.groups;
  return groups !== undefined &&
    groups.data !== undefined &&
    groups.iv !== undefined &&
    groups.tag !== undefined &&
    groups.type !== undefined &&
    [groups.data, groups.iv, groups.tag].every(isCanonicalBase64)
    ? groups.type
    : null;
};

export const isSopsEncryptedScalar = (value: unknown): boolean =>
  sopsEnvelopeType(value) !== null;

export const isSopsEncryptedString = (value: unknown): boolean =>
  sopsEnvelopeType(value) === 'str';

export const isEncryptedLeafValue = (value: unknown): boolean =>
  isSopsEncryptedScalar(value) ||
  (Array.isArray(value) &&
    value.length > 0 &&
    value.every(isSopsEncryptedScalar));

export const looksEncrypted = (value: unknown): boolean =>
  (typeof value === 'string' && value.startsWith('ENC[')) ||
  (Array.isArray(value) &&
    value.some((item) => typeof item === 'string' && item.startsWith('ENC[')));

const hasRequiredStringFields = (
  value: unknown,
  fields: ReadonlyArray<string>,
): boolean =>
  isRecord(value) &&
  fields.every(
    (field) => typeof value[field] === 'string' && value[field].length > 0,
  );

const hasCompleteSource = (value: unknown, source: SopsSource): boolean => {
  const fields = SOPS_SOURCE_FIELDS.get(source);
  return (
    fields !== undefined &&
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => hasRequiredStringFields(entry, fields))
  );
};

const hasCompleteSources = (value: Record<string, unknown>): boolean => {
  const present = SOPS_SOURCES.filter((source) => value[source] !== undefined);
  return (
    present.length > 0 &&
    present.every((source) => hasCompleteSource(value[source], source))
  );
};

const hasCompleteKeyGroups = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((group) => isRecord(group) && hasCompleteSources(group));

const hasCompleteRecipients = (value: Record<string, unknown>): boolean => {
  const hasDirectSource = SOPS_SOURCES.some(
    (source) => value[source] !== undefined,
  );
  const hasKeyGroups = value.key_groups !== undefined;
  return (
    (hasDirectSource || hasKeyGroups) &&
    (!hasDirectSource || hasCompleteSources(value)) &&
    (!hasKeyGroups || hasCompleteKeyGroups(value.key_groups))
  );
};

export const hasCompleteSopsMetadata = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.version === 'string' &&
  SOPS_VERSION.test(value.version) &&
  isSopsEncryptedScalar(value.mac) &&
  hasCompleteRecipients(value);
