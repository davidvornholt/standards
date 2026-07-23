// R2 provider ground truth, pinned against
// https://developers.cloudflare.com/r2/api/tokens/ the same way the wire
// contract suite pins request lines: implementations must match this table,
// and reviews verify the table against the linked documentation.

import { describe, expect, it } from 'bun:test';
import {
  deriveS3SecretAccessKey,
  destinationFormatOf,
  destinationWrites,
  isR2BucketName,
  r2BucketResource,
  s3Endpoint,
  s3PairPaths,
} from './creds-r2';

const ACCOUNT_ID_LENGTH = 32;
const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
// printf '%s' 'cfat_example' | sha256sum
const EXAMPLE_SHA =
  '7cc98f6102d14504591961950bc270e4f88ac3767658273cb12d199257d3b328';

describe('R2 provider ground truth', () => {
  it('pins the bucket resource scope string', () => {
    expect(r2BucketResource(ACCOUNT, 'my-bucket')).toBe(
      `com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_my-bucket`,
    );
  });

  it('pins the S3 credential derivation: token ID and SHA-256 of the value', () => {
    expect(deriveS3SecretAccessKey('cfat_example')).toBe(EXAMPLE_SHA);
    expect(
      destinationWrites('s3', 'ci.r2', 'token-id', 'cfat_example'),
    ).toEqual([
      { path: 'ci.r2.access_key_id', value: 'token-id' },
      { path: 'ci.r2.secret_access_key', value: EXAMPLE_SHA },
    ]);
  });

  it('pins the S3 endpoint URL', () => {
    expect(s3Endpoint(ACCOUNT)).toBe(
      `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    );
  });

  it('stores a bearer token at the key itself', () => {
    expect(
      destinationWrites('bearer', 'ci.token', 'token-id', 'cfat_x'),
    ).toEqual([{ path: 'ci.token', value: 'cfat_x' }]);
  });

  it('accepts R2 bucket names and rejects everything else', () => {
    expect(isR2BucketName('my-bucket')).toBe(true);
    expect(isR2BucketName('abc')).toBe(true);
    expect(isR2BucketName('ab')).toBe(false);
    expect(isR2BucketName('My-Bucket')).toBe(false);
    expect(isR2BucketName('-leading')).toBe(false);
    expect(isR2BucketName('dot.name')).toBe(false);
    expect(isR2BucketName('x'.repeat(ACCOUNT_ID_LENGTH * 2))).toBe(false);
  });
});

describe('destination format inference', () => {
  it('infers bearer, s3, partial, and absent from the SOPS key structure', () => {
    expect(destinationFormatOf(new Set(['ci.token']), 'ci.token')).toBe(
      'bearer',
    );
    expect(
      destinationFormatOf(
        new Set(['ci.r2.access_key_id', 'ci.r2.secret_access_key']),
        'ci.r2',
      ),
    ).toBe('s3');
    expect(destinationFormatOf(new Set(['ci.r2.access_key_id']), 'ci.r2')).toBe(
      'partial',
    );
    expect(destinationFormatOf(new Set(['ci.other']), 'ci.r2')).toBe('absent');
    expect(destinationFormatOf(undefined, 'ci.r2')).toBe('absent');
    expect(s3PairPaths('ci.r2')).toEqual([
      'ci.r2.access_key_id',
      'ci.r2.secret_access_key',
    ]);
  });
});
