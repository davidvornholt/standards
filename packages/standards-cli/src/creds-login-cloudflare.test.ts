import { afterEach, describe, expect, it } from 'bun:test';
import { verifyCloudflareBootstrapAuthority } from './creds-login-cloudflare';

const ACCOUNT_ID_LENGTH = 32;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const TOKEN = 'cfat_bootstrap_secret';
const originalFetch = globalThis.fetch;
const calls: Array<string> = [];

const response = (result: unknown, status = 200): Response =>
  new Response(
    JSON.stringify({
      success: status < HTTP_BAD_REQUEST,
      errors: status < HTTP_BAD_REQUEST ? [] : [{ message: 'not authorized' }],
      result,
    }),
    { status },
  );

const emptyTokenListResponse = (): Response =>
  new Response(
    '{"success":true,"errors":[],"result":[],"result_info":{"page":1,"per_page":50,"count":0,"total_count":0}}',
  );

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

describe('Cloudflare bootstrap authority', () => {
  it('requires both active verification and token-list authority', async () => {
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      return Promise.resolve(
        url.endsWith('/verify')
          ? response({ id: 'bootstrap', status: 'active' })
          : emptyTokenListResponse(),
      );
    }) as typeof fetch;

    expect(await verifyCloudflareBootstrapAuthority(ACCOUNT, TOKEN)).toEqual({
      ok: true,
      value: null,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(
      `/accounts/${ACCOUNT}/tokens?include_expired=true&page=1&per_page=50`,
    );
  });

  it('rejects an active token that cannot list account tokens', async () => {
    globalThis.fetch = ((input: string | URL | Request) =>
      Promise.resolve(
        String(input).endsWith('/verify')
          ? response({ id: 'bootstrap', status: 'active' })
          : response(null, HTTP_FORBIDDEN),
      )) as typeof fetch;

    const verified = await verifyCloudflareBootstrapAuthority(ACCOUNT, TOKEN);
    expect(verified).toEqual({
      ok: false,
      problem: expect.stringContaining('Account / Account API Tokens / Edit'),
    });
    expect(JSON.stringify(verified)).not.toContain(TOKEN);
  });

  it('does not attempt the list check for an inactive token', async () => {
    globalThis.fetch = ((input: string | URL | Request) => {
      calls.push(String(input));
      return Promise.resolve(response({ id: 'bootstrap', status: 'disabled' }));
    }) as typeof fetch;

    expect(await verifyCloudflareBootstrapAuthority(ACCOUNT, TOKEN)).toEqual({
      ok: false,
      problem: 'token status is "disabled", not "active"',
    });
    expect(calls).toHaveLength(1);
  });
});
