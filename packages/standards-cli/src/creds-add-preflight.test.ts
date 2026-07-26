import { describe, expect, it } from 'bun:test';
import { resolveResourceFlags } from './creds-add-preflight';

const ZONE_ID_LENGTH = 32;
const ZONE_A = `1${'b'.repeat(ZONE_ID_LENGTH - 1)}`;

describe('resolveResourceFlags', () => {
  it('targets the account when neither --bucket nor --zone is given', () => {
    expect(
      resolveResourceFlags({ bucket: undefined, zone: undefined }),
    ).toEqual({ ok: true, resource: { kind: 'account' } });
  });

  it('carries the bucket and its jurisdiction, defaulting the jurisdiction', () => {
    expect(resolveResourceFlags({ bucket: 'assets', zone: undefined })).toEqual(
      {
        ok: true,
        resource: { kind: 'bucket', bucket: 'assets', jurisdiction: 'default' },
      },
    );
    expect(
      resolveResourceFlags({
        bucket: 'assets',
        zone: undefined,
        jurisdiction: 'eu',
      }),
    ).toEqual({
      ok: true,
      resource: { kind: 'bucket', bucket: 'assets', jurisdiction: 'eu' },
    });
  });

  it('rejects an invalid bucket name', () => {
    expect(
      resolveResourceFlags({ bucket: 'Bad_Bucket', zone: undefined }),
    ).toEqual({
      ok: false,
      problem:
        'invalid R2 bucket name: Bad_Bucket (3-63 lowercase letters, digits, and hyphens)',
    });
  });

  it('carries the parsed zones', () => {
    expect(resolveResourceFlags({ bucket: undefined, zone: ZONE_A })).toEqual({
      ok: true,
      resource: { kind: 'zones', zoneIds: [ZONE_A] },
    });
  });

  it('passes a zone parsing problem through', () => {
    const flags = resolveResourceFlags({
      bucket: undefined,
      zone: 'example.test',
    });
    expect(flags).toEqual({
      ok: false,
      problem: expect.stringContaining('not a zone ID: example.test'),
    });
  });

  // The two flags describe different tokens, so the combination is refused
  // rather than silently resolved to one of them.
  it('refuses --bucket together with --zone', () => {
    expect(resolveResourceFlags({ bucket: 'assets', zone: ZONE_A })).toEqual({
      ok: false,
      problem:
        '--bucket and --zone cannot be combined; an R2 bucket credential and a zone credential are separate tokens',
    });
  });
});
