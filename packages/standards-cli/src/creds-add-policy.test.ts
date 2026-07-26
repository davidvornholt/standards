import { afterEach, describe, expect, it } from 'bun:test';
import {
  resolveTokenPolicy,
  unsupportedResourceScopes,
} from './creds-add-policy';
import {
  ACCOUNT,
  BROKER_ACCOUNT,
  restoreFetch,
  stubGroups,
} from './creds-add-policy-test-support';

afterEach(restoreFetch);

describe('unsupportedResourceScopes', () => {
  it('names groups that cannot target the requested resource scope', () => {
    expect(
      unsupportedResourceScopes(
        [
          {
            id: 'zone',
            name: 'DNS Write',
            scopes: ['com.cloudflare.api.account.zone'],
          },
          {
            id: 'account',
            name: 'Workers Scripts Write',
            scopes: ['com.cloudflare.api.account'],
          },
        ],
        'com.cloudflare.api.account',
      ),
    ).toEqual(['DNS Write']);
  });
});

describe('resolveTokenPolicy', () => {
  it('targets the account resource for account-scoped groups', async () => {
    stubGroups([
      {
        id: 'pg',
        name: 'Workers Scripts Write',
        scopes: ['com.cloudflare.api.account'],
      },
    ]);
    expect(
      await resolveTokenPolicy(BROKER_ACCOUNT, {
        permissions: 'Workers Scripts Write',
        resource: { kind: 'account' },
      }),
    ).toEqual({
      ok: true,
      wanted: ['Workers Scripts Write'],
      policies: [
        {
          effect: 'allow',
          resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: '*' },
          // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
          permission_groups: [{ id: 'pg' }],
        },
      ],
    });
  });

  it('targets the bucket resource for bucket-item groups', async () => {
    stubGroups([
      {
        id: 'r2',
        name: 'Workers R2 Storage Bucket Item Write',
        scopes: ['com.cloudflare.edge.r2.bucket'],
      },
    ]);
    expect(
      await resolveTokenPolicy(BROKER_ACCOUNT, {
        permissions: 'Workers R2 Storage Bucket Item Write',
        resource: { kind: 'bucket', bucket: 'assets', jurisdiction: 'default' },
      }),
    ).toEqual({
      ok: true,
      wanted: ['Workers R2 Storage Bucket Item Write'],
      policies: [
        {
          effect: 'allow',
          resources: {
            [`com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_assets`]: '*',
          },
          // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
          permission_groups: [{ id: 'r2' }],
        },
      ],
    });
  });

  it('targets an EU-jurisdiction bucket resource', async () => {
    stubGroups([
      {
        id: 'r2',
        name: 'Workers R2 Storage Bucket Item Read',
        scopes: ['com.cloudflare.edge.r2.bucket'],
      },
    ]);
    expect(
      await resolveTokenPolicy(BROKER_ACCOUNT, {
        permissions: 'Workers R2 Storage Bucket Item Read',
        resource: { kind: 'bucket', bucket: 'assets', jurisdiction: 'eu' },
      }),
    ).toEqual({
      ok: true,
      wanted: ['Workers R2 Storage Bucket Item Read'],
      policies: [
        {
          effect: 'allow',
          resources: {
            [`com.cloudflare.edge.r2.bucket.${ACCOUNT}_eu_assets`]: '*',
          },
          // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
          permission_groups: [{ id: 'r2' }],
        },
      ],
    });
  });

  it('rejects bucket-item groups without --bucket', async () => {
    stubGroups([
      {
        id: 'r2',
        name: 'Workers R2 Storage Bucket Item Read',
        scopes: ['com.cloudflare.edge.r2.bucket'],
      },
    ]);
    const resolved = await resolveTokenPolicy(BROKER_ACCOUNT, {
      permissions: 'Workers R2 Storage Bucket Item Read',
      resource: { kind: 'account' },
    });
    expect(resolved).toEqual({
      ok: false,
      problem: expect.stringContaining(
        'or pass --bucket for R2 bucket-item groups',
      ),
    });
  });
});
