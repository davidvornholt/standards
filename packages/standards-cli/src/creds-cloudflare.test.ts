import { afterEach, describe, expect, it } from 'bun:test';
import { listAccountTokens, verifyAccountToken } from './creds-cloudflare';

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

  it('treats a non-JSON body as a failure, never a success', async () => {
    stubFetch(() => ({ status: 502, body: undefined }));
    const listed = await listAccountTokens(ACCOUNT, 'cfat');
    expect(listed.ok).toBe(false);
  });
});
