import { afterEach, describe, expect, it } from 'bun:test';
import {
  createAccountToken,
  deleteAccountToken,
  listAccountTokens,
  listPermissionGroups,
  verifyAccountToken,
} from './creds-cloudflare';

const ACCOUNT_ID_LENGTH = 32;
const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const HTTP_OK = 200;
const PAGINATED_TOKEN_COUNT = 51;
const originalFetch = globalThis.fetch;

type Call = { readonly method: string; readonly url: string };
const calls: Array<Call> = [];

const stubFetch = (
  handler: (
    url: string,
    init: RequestInit | undefined,
  ) => { status?: number; body: unknown },
): void => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url });
    const { status, body } = handler(url, init);
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: status ?? HTTP_OK }),
    );
  }) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

const envelope = (result: unknown, info?: unknown): unknown => ({
  success: true,
  errors: [],
  result,
  ...(info === undefined ? {} : { result_info: info }),
});

describe('cloudflare account token client', () => {
  it('verifies the bootstrap token and reports its status', async () => {
    stubFetch(() => ({ body: envelope({ id: 't', status: 'active' }) }));
    const verified = await verifyAccountToken(ACCOUNT, 'cfat');
    expect(verified).toEqual({ ok: true, value: 'active' });
    expect(calls[0]?.url).toContain(`/accounts/${ACCOUNT}/tokens/verify`);
  });

  it('folds API error messages into the problem', async () => {
    stubFetch(() => ({
      status: 403,
      body: { success: false, errors: [{ message: 'not entitled' }] },
    }));
    const verified = await verifyAccountToken(ACCOUNT, 'cfat');
    expect(verified).toEqual({
      ok: false,
      problem: expect.stringContaining('not entitled'),
    });
  });

  it('paginates from documented result counts and normalizes entries', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `${index + 1}`,
      name: `token-${index + 1}`,
      status: 'active',
      expires_on: '2027-01-01T00:00:00Z',
      issued_on: '2026-10-01T00:00:00Z',
      policies: [
        {
          effect: 'allow',
          resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: '*' },
          permission_groups: [{ id: 'pg' }],
        },
      ],
    }));
    stubFetch((url) =>
      url.includes('page=2')
        ? {
            body: envelope([{ id: '51', name: 'last', status: 'active' }], {
              page: 2,
              per_page: 50,
              count: 1,
              total_count: 51,
            }),
          }
        : {
            body: envelope(firstPage, {
              page: 1,
              per_page: 50,
              count: 50,
              total_count: 51,
            }),
          },
    );
    const listed = await listAccountTokens(ACCOUNT, 'cfat');
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      throw new Error(listed.problem);
    }
    expect(listed.value).toHaveLength(PAGINATED_TOKEN_COUNT);
    expect(listed.value[0]).toEqual(
      expect.objectContaining({
        id: '1',
        issuedOn: '2026-10-01T00:00:00Z',
        policies: [
          expect.objectContaining({
            resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: '*' },
          }),
        ],
      }),
    );
    expect(calls.map((call) => call.url)).toEqual([
      expect.stringContaining('include_expired=true&page=1&per_page=50'),
      expect.stringContaining('include_expired=true&page=2&per_page=50'),
    ]);
  });

  it('fails closed when token pagination metadata is undocumented', async () => {
    stubFetch(() => ({
      body: envelope([{ id: '1', name: 'a', status: 'active' }], {
        page: 1,
        total_pages: 1,
      }),
    }));
    const listed = await listAccountTokens(ACCOUNT, 'cfat');
    expect(listed).toEqual({
      ok: false,
      problem: expect.stringContaining('pagination metadata'),
    });
  });
});

describe('cloudflare token mutations and permission groups', () => {
  it('preserves permission-group scopes', async () => {
    stubFetch(() => ({
      body: envelope([
        {
          id: 'pg',
          name: 'Workers Scripts Write',
          scopes: ['com.cloudflare.api.account'],
        },
      ]),
    }));
    expect(await listPermissionGroups(ACCOUNT, 'cfat')).toEqual({
      ok: true,
      value: [
        {
          id: 'pg',
          name: 'Workers Scripts Write',
          scopes: ['com.cloudflare.api.account'],
        },
      ],
    });
  });

  it('creates a token and returns id and value only', async () => {
    stubFetch(() => ({ body: envelope({ id: 'new', value: 'cfat_minted' }) }));
    const created = await createAccountToken(ACCOUNT, 'cfat', {
      name: 'standards/o/r/ci/ci.key',
      policies: [
        {
          effect: 'allow',
          resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: '*' },
          permission_groups: [{ id: 'pg' }],
        },
      ],
      expiresOn: '2026-10-01T00:00:00Z',
    });
    expect(created).toEqual({
      ok: true,
      value: { id: 'new', value: 'cfat_minted' },
    });
    expect(calls[0]?.method).toBe('POST');
  });

  it('deletes tokens', async () => {
    stubFetch(() => ({ body: envelope({ id: 'gone' }) }));
    const deleted = await deleteAccountToken(ACCOUNT, 'cfat', 'tok');
    expect(deleted.ok).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(['DELETE']);
  });

  it('treats a non-JSON body as a failure, never a success', async () => {
    stubFetch(() => ({ status: 502, body: undefined }));
    const listed = await listAccountTokens(ACCOUNT, 'cfat');
    expect(listed.ok).toBe(false);
  });
});
