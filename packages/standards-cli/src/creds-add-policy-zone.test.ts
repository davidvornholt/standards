import { afterEach, describe, expect, it } from 'bun:test';
import { resolveTokenPolicy } from './creds-add-policy';
import {
  ACCOUNT,
  BROKER_ACCOUNT,
  restoreFetch,
  stubGroups,
} from './creds-add-policy-test-support';

afterEach(restoreFetch);

const ZONE_ID_LENGTH = 32;
const ZONE_A = `1${'b'.repeat(ZONE_ID_LENGTH - 1)}`;
const ZONE_B = `2${'c'.repeat(ZONE_ID_LENGTH - 1)}`;
const DNS_WRITE = {
  id: 'dns',
  name: 'DNS Write',
  scopes: ['com.cloudflare.api.account.zone'],
};
const R2_WRITE = {
  id: 'r2',
  name: 'Workers R2 Storage Write',
  scopes: ['com.cloudflare.api.account'],
};

describe('resolveTokenPolicy with zones', () => {
  it('gives every named zone one policy carrying the zone-scoped groups', async () => {
    stubGroups([DNS_WRITE]);
    expect(
      await resolveTokenPolicy(BROKER_ACCOUNT, {
        permissions: 'DNS Write',
        bucket: undefined,
        zoneIds: [ZONE_A, ZONE_B],
      }),
    ).toEqual({
      ok: true,
      wanted: ['DNS Write'],
      policies: [
        {
          effect: 'allow',
          resources: {
            [`com.cloudflare.api.account.zone.${ZONE_A}`]: '*',
            [`com.cloudflare.api.account.zone.${ZONE_B}`]: '*',
          },
          // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
          permission_groups: [{ id: 'dns' }],
        },
      ],
    });
  });

  // The credential this exists for holds R2 access alongside DNS access, and
  // Cloudflare will not accept an account-scoped group against a zone resource.
  it('splits a mixed selection across an account and a zone policy', async () => {
    stubGroups([DNS_WRITE, R2_WRITE]);
    const resolved = await resolveTokenPolicy(BROKER_ACCOUNT, {
      permissions: 'Workers R2 Storage Write,DNS Write',
      bucket: undefined,
      zoneIds: [ZONE_A],
    });
    expect(resolved).toEqual({
      ok: true,
      wanted: ['Workers R2 Storage Write', 'DNS Write'],
      policies: [
        {
          effect: 'allow',
          resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: '*' },
          // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
          permission_groups: [{ id: 'r2' }],
        },
        {
          effect: 'allow',
          resources: { [`com.cloudflare.api.account.zone.${ZONE_A}`]: '*' },
          // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
          permission_groups: [{ id: 'dns' }],
        },
      ],
    });
  });

  it('rejects a zone selection holding no zone-scoped group', async () => {
    stubGroups([R2_WRITE]);
    expect(
      await resolveTokenPolicy(BROKER_ACCOUNT, {
        permissions: 'Workers R2 Storage Write',
        bucket: undefined,
        zoneIds: [ZONE_A],
      }),
    ).toEqual({
      ok: false,
      problem:
        '--zone was given but no selected permission group is zone-scoped; drop --zone, or add a zone-scoped group such as DNS Write',
    });
  });

  it('names a group that targets neither a zone nor an account resource', async () => {
    stubGroups([
      DNS_WRITE,
      {
        id: 'item',
        name: 'Workers R2 Storage Bucket Item Write',
        scopes: ['com.cloudflare.edge.r2.bucket'],
      },
    ]);
    const resolved = await resolveTokenPolicy(BROKER_ACCOUNT, {
      permissions: 'DNS Write,Workers R2 Storage Bucket Item Write',
      bucket: undefined,
      zoneIds: [ZONE_A],
    });
    expect(resolved).toEqual({
      ok: false,
      problem:
        'permission group(s) Workers R2 Storage Bucket Item Write target neither a zone nor an account resource; R2 bucket-item groups require --bucket, which cannot be combined with --zone',
    });
  });

  it('refuses to combine a bucket resource with zones', async () => {
    stubGroups([DNS_WRITE]);
    expect(
      await resolveTokenPolicy(BROKER_ACCOUNT, {
        permissions: 'DNS Write',
        bucket: 'my-bucket',
        zoneIds: [ZONE_A],
      }),
    ).toEqual({
      ok: false,
      problem:
        '--bucket and --zone cannot be combined; an R2 bucket credential and a zone credential are separate tokens',
    });
  });
});
