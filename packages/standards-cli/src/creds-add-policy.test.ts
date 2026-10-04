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
  it.each([
    {
      label: 'the account resource for account-scoped groups',
      group: 'Workers Scripts Write',
      scope: 'com.cloudflare.api.account',
      resource: { kind: 'account' },
      resourceKey: `com.cloudflare.api.account.${ACCOUNT}`,
    },
    {
      label: 'the bucket resource for bucket-item groups',
      group: 'Workers R2 Storage Bucket Item Write',
      scope: 'com.cloudflare.edge.r2.bucket',
      resource: { kind: 'bucket', bucket: 'assets', jurisdiction: 'default' },
      resourceKey: `com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_assets`,
    },
    {
      label: 'an EU-jurisdiction bucket resource',
      group: 'Workers R2 Storage Bucket Item Read',
      scope: 'com.cloudflare.edge.r2.bucket',
      resource: { kind: 'bucket', bucket: 'assets', jurisdiction: 'eu' },
      resourceKey: `com.cloudflare.edge.r2.bucket.${ACCOUNT}_eu_assets`,
    },
  ] as const)(
    'targets $label',
    async ({ group, scope, resource, resourceKey }) => {
      stubGroups([{ id: 'pg', name: group, scopes: [scope] }]);
      expect(
        await resolveTokenPolicy(BROKER_ACCOUNT, {
          permissions: group,
          resource,
        }),
      ).toEqual({
        ok: true,
        wanted: [group],
        policies: [
          {
            effect: 'allow',
            resources: { [resourceKey]: '*' },
            // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
            permission_groups: [{ id: 'pg' }],
          },
        ],
      });
    },
  );

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
