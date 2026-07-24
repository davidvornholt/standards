import { afterEach, describe, expect, it } from 'bun:test';
import {
  resolveTokenPolicy,
  unsupportedResourceScopes,
} from './creds-add-policy';

const ACCOUNT_ID_LENGTH = 32;
const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const BROKER_ACCOUNT = { accountId: ACCOUNT, token: 'bootstrap' };
const originalFetch = globalThis.fetch;

const stubGroups = (groups: ReadonlyArray<unknown>): void => {
  globalThis.fetch = ((_input: string | URL | Request) =>
    Promise.resolve(
      Response.json({ success: true, errors: [], result: groups }),
    )) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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
        bucket: undefined,
      }),
    ).toEqual({
      ok: true,
      wanted: ['Workers Scripts Write'],
      policy: {
        effect: 'allow',
        resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: '*' },
        // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
        permission_groups: [{ id: 'pg' }],
      },
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
        bucket: 'assets',
      }),
    ).toEqual({
      ok: true,
      wanted: ['Workers R2 Storage Bucket Item Write'],
      policy: {
        effect: 'allow',
        resources: {
          [`com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_assets`]: '*',
        },
        // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
        permission_groups: [{ id: 'r2' }],
      },
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
        bucket: 'assets',
        jurisdiction: 'eu',
      }),
    ).toEqual({
      ok: true,
      wanted: ['Workers R2 Storage Bucket Item Read'],
      policy: {
        effect: 'allow',
        resources: {
          [`com.cloudflare.edge.r2.bucket.${ACCOUNT}_eu_assets`]: '*',
        },
        // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
        permission_groups: [{ id: 'r2' }],
      },
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
      bucket: undefined,
    });
    expect(resolved).toEqual({
      ok: false,
      problem: expect.stringContaining(
        'R2 bucket-item groups require --bucket',
      ),
    });
  });

  it('rejects an invalid bucket name before any provider call', async () => {
    globalThis.fetch = ((_input: string | URL | Request): Promise<Response> => {
      throw new Error('no provider call expected');
    }) as typeof fetch;
    const resolved = await resolveTokenPolicy(BROKER_ACCOUNT, {
      permissions: 'Workers R2 Storage Bucket Item Read',
      bucket: 'Bad_Bucket',
    });
    expect(resolved).toEqual({
      ok: false,
      problem: expect.stringContaining('invalid R2 bucket name'),
    });
  });
});
