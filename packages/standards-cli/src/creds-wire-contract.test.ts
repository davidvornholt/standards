// Provider wire contract: every outbound request line the creds modules
// emit, pinned as an exact `METHOD full-url` string with a link to the
// provider documentation that defines it. Implementations must match this
// table, never the other way round — reviews verify the table against the
// linked docs. This gate exists because a route typo (app-manifest vs
// app-manifests) gets the provider's generic 404, indistinguishable from an
// expired credential, and is invisible to every test that stubs by
// substring.

import { afterEach, describe, expect, it } from 'bun:test';
import {
  createAccountToken,
  deleteAccountToken,
  listAccountTokens,
  listPermissionGroups,
  verifyAccountToken,
} from './creds-cloudflare';
import { cloudflareExpiresOn } from './creds-cloudflare-expiry';
import { convertManifestCode } from './creds-login-github-manifest';

const ACCOUNT_ID_LENGTH = 32;
const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const CF = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NOT_FOUND = 404;

const originalFetch = globalThis.fetch;
const requests: Array<string> = [];

const stubFetch = (status: number, body: unknown): void => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return Promise.resolve(Response.json(body, { status }));
  }) as typeof fetch;
};

const cfEnvelope = (result: unknown): unknown => ({
  success: true,
  errors: [],
  result,
  // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
  result_info: { page: 1, per_page: 50, count: 0, total_count: 0 },
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  requests.length = 0;
});

describe('provider wire contract', () => {
  // https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest
  it('GitHub manifest conversion: POST /app-manifests/{code}/conversions', async () => {
    stubFetch(HTTP_CREATED, {
      id: 1,
      slug: 's',
      // biome-ignore lint/style/useNamingConvention: GitHub's response field is snake_case.
      html_url: 'https://github.com/apps/s',
      // biome-ignore lint/style/useNamingConvention: GitHub's response field is snake_case.
      client_id: 'Iv1.x',
      pem: '-----BEGIN RSA PRIVATE KEY-----',
    });
    expect((await convertManifestCode('code123')).ok).toBe(true);
    expect(requests).toEqual([
      'POST https://api.github.com/app-manifests/code123/conversions',
    ]);
  });

  it('preserves GitHub manifest conversion errors', async () => {
    stubFetch(HTTP_NOT_FOUND, { message: 'manifest code expired' });

    expect(await convertManifestCode('expired')).toEqual({
      ok: false,
      problem: 'manifest conversion: HTTP 404 manifest code expired',
    });
  });

  it('rejects manifest conversions missing credentials', async () => {
    stubFetch(HTTP_CREATED, { id: 1, slug: 's' });

    expect(await convertManifestCode('code123')).toEqual({
      ok: false,
      problem: 'unexpected manifest conversion response shape',
    });
  });

  // https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/
  it('Cloudflare token verify: GET /accounts/{id}/tokens/verify', async () => {
    stubFetch(HTTP_OK, cfEnvelope({ id: 't', status: 'active' }));
    expect((await verifyAccountToken(ACCOUNT, 'cfat')).ok).toBe(true);
    expect(requests).toEqual([`GET ${CF}/tokens/verify`]);
  });

  // https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/list/
  it('Cloudflare token list: GET /accounts/{id}/tokens', async () => {
    stubFetch(HTTP_OK, cfEnvelope([]));
    expect((await listAccountTokens(ACCOUNT, 'cfat')).ok).toBe(true);
    expect(requests).toEqual([
      `GET ${CF}/tokens?include_expired=true&page=1&per_page=50`,
    ]);
  });

  // https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/subresources/permission_groups/methods/list/
  it('Cloudflare permission groups: GET /accounts/{id}/tokens/permission_groups', async () => {
    stubFetch(HTTP_OK, cfEnvelope([]));
    expect((await listPermissionGroups(ACCOUNT, 'cfat')).ok).toBe(true);
    expect(requests).toEqual([
      `GET ${CF}/tokens/permission_groups?per_page=1000`,
    ]);
  });

  // https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/
  it('Cloudflare token create: POST /accounts/{id}/tokens', async () => {
    stubFetch(HTTP_OK, cfEnvelope({ id: 'new', value: 'cfat_minted' }));
    const created = await createAccountToken(ACCOUNT, 'cfat', {
      name: 'standards/o/r/ci/ci.key',
      policies: [],
      expiresOn: null,
      condition: null,
    });
    expect(created.ok).toBe(true);
    expect(requests).toEqual([`POST ${CF}/tokens`]);
  });

  // https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/
  // Cloudflare rejects fractional seconds in expires_on before creating the
  // token: `expires_on must be a valid date/time in the format
  // "2005-12-30T01:02:03Z"`.
  it('Cloudflare expires_on: whole-second RFC3339, no fractional part', () => {
    const withMillis = Date.parse('2026-10-21T20:03:23.989Z');
    expect(cloudflareExpiresOn(withMillis)).toBe('2026-10-21T20:03:23Z');
  });

  // https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/delete/
  it('Cloudflare token delete: DELETE /accounts/{id}/tokens/{token_id}', async () => {
    stubFetch(HTTP_OK, cfEnvelope({ id: 'gone' }));
    expect((await deleteAccountToken(ACCOUNT, 'cfat', 'tok1')).ok).toBe(true);
    expect(requests).toEqual([`DELETE ${CF}/tokens/tok1`]);
  });
});
