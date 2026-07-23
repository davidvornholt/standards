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

const tokenListResponse = (
  tokens: ReadonlyArray<{ id: string; name: string }>,
): Response =>
  Response.json({
    success: true,
    errors: [],
    result: tokens.map((entry) => ({ ...entry, status: 'active' })),
    // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
    result_info: {
      page: 1,
      // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
      per_page: 50,
      count: tokens.length,
      // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
      total_count: tokens.length,
    },
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

describe('Cloudflare bootstrap authority', () => {
  it('rejects a complete token list missing the verified token ID', async () => {
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      return Promise.resolve(
        url.endsWith('/verify')
          ? response({ id: 'bootstrap', status: 'active' })
          : tokenListResponse([]),
      );
    }) as typeof fetch;

    expect(await verifyCloudflareBootstrapAuthority(ACCOUNT, TOKEN)).toEqual({
      ok: false,
      problem: expect.stringContaining('verified token ID'),
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(
      `/accounts/${ACCOUNT}/tokens?include_expired=true&page=1&per_page=50`,
    );
  });

  it.each([
    ['missing', { status: 'active' }],
    ['non-string', { id: 7, status: 'active' }],
  ])('rejects a %s verification ID', async (_, verifyResult) => {
    globalThis.fetch = ((input: string | URL | Request) =>
      Promise.resolve(
        String(input).endsWith('/verify')
          ? response(verifyResult)
          : tokenListResponse([
              {
                id: 'unsafe',
                name: 'standards/davidvornholt/example/ci/ci.token',
              },
            ]),
      )) as typeof fetch;

    expect(await verifyCloudflareBootstrapAuthority(ACCOUNT, TOKEN)).toEqual({
      ok: false,
      problem: expect.stringContaining('valid token ID'),
    });
  });

  it('reports the pasted token name for the recommendation check', async () => {
    globalThis.fetch = ((input: string | URL | Request) =>
      Promise.resolve(
        String(input).endsWith('/verify')
          ? response({ id: 'bootstrap', status: 'active' })
          : tokenListResponse([
              { id: 'other', name: 'unrelated' },
              { id: 'bootstrap', name: 'my-token' },
            ]),
      )) as typeof fetch;

    expect(await verifyCloudflareBootstrapAuthority(ACCOUNT, TOKEN)).toEqual({
      ok: true,
      value: { tokenName: 'my-token' },
    });
  });

  it('rejects a bootstrap token named inside the minted namespace', async () => {
    globalThis.fetch = ((input: string | URL | Request) =>
      Promise.resolve(
        String(input).endsWith('/verify')
          ? response({ id: 'bootstrap', status: 'active' })
          : tokenListResponse([
              { id: 'bootstrap', name: 'standards/o/r/ci/ci.key' },
            ]),
      )) as typeof fetch;

    expect(await verifyCloudflareBootstrapAuthority(ACCOUNT, TOKEN)).toEqual({
      ok: false,
      problem: expect.stringContaining('must remain distinguishable'),
    });
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
