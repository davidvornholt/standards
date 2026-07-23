import { afterEach, describe, expect, it } from 'bun:test';
import {
  createAccountToken,
  deleteAccountToken,
  listAccountTokens,
  rollAccountToken,
  verifyAccountToken,
} from './creds-cloudflare';

const ACCOUNT_ID_LENGTH = 32;
const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const HTTP_OK = 200;
const originalFetch = globalThis.fetch;

type Call = { readonly method: string; readonly url: string };
const calls: Array<Call> = [];

const stubFetch = (
  handler: (url: string) => { status?: number; body: unknown },
): void => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url });
    const { status, body } = handler(url);
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

  it('paginates the token list and normalizes entries', async () => {
    stubFetch((url) =>
      url.includes('page=2')
        ? {
            body: envelope([{ id: '2', name: 'b', status: 'active' }], {
              page: 2,
              total_pages: 2,
            }),
          }
        : {
            body: envelope(
              [
                {
                  id: '1',
                  name: 'a',
                  status: 'active',
                  expires_on: '2027-01-01T00:00:00Z',
                },
              ],
              { page: 1, total_pages: 2 },
            ),
          },
    );
    const listed = await listAccountTokens(ACCOUNT, 'cfat');
    expect(listed).toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          id: '1',
          expiresOn: '2027-01-01T00:00:00Z',
        }),
        expect.objectContaining({ id: '2', expiresOn: null }),
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

  it('rolls a token value and deletes tokens', async () => {
    stubFetch((url) =>
      url.endsWith('/value')
        ? { body: envelope('cfat_rolled') }
        : { body: envelope({ id: 'gone' }) },
    );
    const rolled = await rollAccountToken(ACCOUNT, 'cfat', 'tok');
    expect(rolled).toEqual({ ok: true, value: 'cfat_rolled' });
    const deleted = await deleteAccountToken(ACCOUNT, 'cfat', 'tok');
    expect(deleted.ok).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(['PUT', 'DELETE']);
  });

  it('treats a non-JSON body as a failure, never a success', async () => {
    stubFetch(() => ({ status: 502, body: undefined }));
    const listed = await listAccountTokens(ACCOUNT, 'cfat');
    expect(listed.ok).toBe(false);
  });
});
