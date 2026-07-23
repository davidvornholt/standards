// Cloudflare R2 ground truth for the credential broker, pinned by
// creds-r2.test.ts against https://developers.cloudflare.com/r2/api/tokens/:
// a bucket-scoped token targets the resource
// `com.cloudflare.edge.r2.bucket.<account_id>_<jurisdiction>_<bucket>`, and
// the S3-compatible credential pair derived from a minted token is access
// key ID = the token's ID, secret access key = the SHA-256 hex digest of the
// token's value.

import { createHash } from 'node:crypto';
import type { SopsValueChange } from './creds-sops';

// Scope the permission_groups endpoint reports for the bucket-item groups
// ("Workers R2 Storage Bucket Item Read"/"... Write"); account-scoped groups
// report `com.cloudflare.api.account` instead.
export const R2_BUCKET_SCOPE = 'com.cloudflare.edge.r2.bucket';

export type R2Jurisdiction = 'default' | 'eu';
export const DEFAULT_R2_JURISDICTION: R2Jurisdiction = 'default';

export const isR2Jurisdiction = (value: string): value is R2Jurisdiction =>
  value === DEFAULT_R2_JURISDICTION || value === 'eu';

// R2 bucket names are 3-63 characters of lowercase letters, digits, and
// hyphens, starting and ending alphanumeric.
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;

export const isR2BucketName = (name: string): boolean => BUCKET_NAME.test(name);

export const r2BucketResource = (
  accountId: string,
  bucket: string,
  jurisdiction: R2Jurisdiction = DEFAULT_R2_JURISDICTION,
): string => `${R2_BUCKET_SCOPE}.${accountId}_${jurisdiction}_${bucket}`;

export const deriveS3SecretAccessKey = (tokenValue: string): string =>
  createHash('sha256').update(tokenValue).digest('hex');

export const s3Endpoint = (
  accountId: string,
  jurisdiction: R2Jurisdiction = DEFAULT_R2_JURISDICTION,
): string =>
  `https://${accountId}.${jurisdiction === 'eu' ? 'eu.' : ''}r2.cloudflarestorage.com`;

export type DestinationFormat = 'bearer' | 's3';

const ACCESS_KEY_SEGMENT = 'access_key_id';
const SECRET_KEY_SEGMENT = 'secret_access_key';
const S3_PAIR_SEGMENTS = [ACCESS_KEY_SEGMENT, SECRET_KEY_SEGMENT] as const;

export const s3AccessKeyPath = (key: string): string =>
  `${key}.${ACCESS_KEY_SEGMENT}`;

export const s3PairPaths = (key: string): ReadonlyArray<string> => [
  s3AccessKeyPath(key),
  `${key}.${SECRET_KEY_SEGMENT}`,
];

export const destinationFootprint = (
  format: DestinationFormat,
  key: string,
): ReadonlyArray<string> => (format === 's3' ? s3PairPaths(key) : [key]);

export const destinationFootprintsIntersect = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean => left.some((path) => right.includes(path));

// The SOPS writes for one minted token: a bearer destination stores the raw
// token value at the key itself; an S3 destination stores the derived
// credential pair under it.
export const destinationWrites = (
  format: DestinationFormat,
  key: string,
  tokenId: string,
  tokenValue: string,
): ReadonlyArray<SopsValueChange> =>
  format === 'bearer'
    ? [{ path: key, value: tokenValue }]
    : [
        { path: `${key}.${ACCESS_KEY_SEGMENT}`, value: tokenId },
        {
          path: `${key}.${SECRET_KEY_SEGMENT}`,
          value: deriveS3SecretAccessKey(tokenValue),
        },
      ];

// Reconciliation infers a destination's format from the plaintext SOPS key
// structure: a leaf at the key is a bearer token, both pair leaves under it
// are an S3 credential, and one pair leaf without the other is unsafe to
// mutate automatically.
export const destinationFormatOf = (
  keys: ReadonlySet<string> | undefined,
  key: string,
): DestinationFormat | 'partial' | 'absent' => {
  if (keys === undefined) {
    return 'absent';
  }
  if (keys.has(key)) {
    return 'bearer';
  }
  const present = s3PairPaths(key).filter((path) => keys.has(path));
  if (present.length === S3_PAIR_SEGMENTS.length) {
    return 's3';
  }
  return present.length === 0 ? 'absent' : 'partial';
};

export const inferredDestinationFootprint = (
  keys: ReadonlySet<string> | undefined,
  key: string,
): ReadonlyArray<string> => {
  const format = destinationFormatOf(keys, key);
  return destinationFootprint(
    format === 's3' || format === 'partial' ? 's3' : 'bearer',
    key,
  );
};
