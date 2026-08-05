import { isRecord } from './github-settings-parse';

const SOPS_ENVELOPE =
  /^ENC\[AES256_GCM,data:(?<data>[A-Za-z0-9+/]+={0,2}),iv:(?<iv>[A-Za-z0-9+/]+={0,2}),tag:(?<tag>[A-Za-z0-9+/]+={0,2}),type:(?:bool|bytes|comment|float|int|str)\]$/u;
const SOPS_VERSION = /^\d+\.\d+\.\d+$/u;
const SOPS_KEY_SOURCES = [
  'age',
  'azure_kv',
  'gcp_kms',
  'hc_vault',
  'key_groups',
  'kms',
  'pgp',
] as const;

const isCanonicalBase64 = (value: string): boolean => {
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
};

export const isSopsEncryptedScalar = (value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false;
  }
  const match = SOPS_ENVELOPE.exec(value);
  const groups = match?.groups;
  return groups !== undefined &&
    groups.data !== undefined &&
    groups.iv !== undefined &&
    groups.tag !== undefined
    ? [groups.data, groups.iv, groups.tag].every(isCanonicalBase64)
    : false;
};

export const isEncryptedLeafValue = (value: unknown): boolean =>
  isSopsEncryptedScalar(value) ||
  (Array.isArray(value) &&
    value.length > 0 &&
    value.every(isSopsEncryptedScalar));

export const looksEncrypted = (value: unknown): boolean =>
  (typeof value === 'string' && value.startsWith('ENC[')) ||
  (Array.isArray(value) &&
    value.some((item) => typeof item === 'string' && item.startsWith('ENC[')));

export const hasCompleteSopsMetadata = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.version === 'string' &&
  SOPS_VERSION.test(value.version) &&
  isSopsEncryptedScalar(value.mac) &&
  SOPS_KEY_SOURCES.some(
    (source) => Array.isArray(value[source]) && value[source].length > 0,
  );
