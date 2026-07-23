import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
  cloudflareBootstrapInstructions,
  verifyCloudflareBootstrapAuthority,
} from './creds-login-cloudflare';
import { BROKER_IDENTITY_NAME } from './creds-naming';

const ACCOUNT_ID_LENGTH = 32;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const TOKEN = 'cfat_bootstrap_secret';
const originalFetch = globalThis.fetch;
const calls: Array<string> = [];
const temporaryDirectories: Array<string> = [];

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
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('Cloudflare bootstrap authority', () => {
  it('rejects an empty token list', async () => {
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
      problem:
        'the verified token was not found in the complete account token list',
    });
  });

  it.each([
    BROKER_IDENTITY_NAME,
    'my-safe-bootstrap-token',
  ])('accepts a matched safe token named %s', async (name) => {
    globalThis.fetch = ((input: string | URL | Request) =>
      Promise.resolve(
        String(input).endsWith('/verify')
          ? response({ id: 'bootstrap', status: 'active' })
          : tokenListResponse([{ id: 'bootstrap', name }]),
      )) as typeof fetch;

    expect(await verifyCloudflareBootstrapAuthority(ACCOUNT, TOKEN)).toEqual({
      ok: true,
      value: { tokenName: name },
    });
  });

  it('rejects a token-list entry with a different id', async () => {
    globalThis.fetch = ((input: string | URL | Request) =>
      Promise.resolve(
        String(input).endsWith('/verify')
          ? response({ id: 'bootstrap', status: 'active' })
          : tokenListResponse([
              { id: 'different', name: BROKER_IDENTITY_NAME },
            ]),
      )) as typeof fetch;

    expect(await verifyCloudflareBootstrapAuthority(ACCOUNT, TOKEN)).toEqual({
      ok: false,
      problem:
        'the verified token was not found in the complete account token list',
    });
  });
});

describe('Cloudflare bootstrap authority rejection', () => {
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
      problem: expect.stringContaining('could revoke it'),
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

  it('does not mutate the broker store when verification omits the id', () => {
    const directory = mkdtempSync(join(tmpdir(), 'creds-login-cloudflare-'));
    temporaryDirectories.push(directory);
    const brokerPath = join(directory, 'broker.yaml');
    const moduleUrl = new URL('./creds-login-cloudflare.ts', import.meta.url)
      .href;
    const script = `globalThis.fetch = (input) => Promise.resolve(String(input).endsWith('/verify')
      ? Response.json({ success: true, errors: [], result: { status: 'active' } })
      : Response.json({ success: true, errors: [], result: [], result_info: { page: 1, per_page: 50, count: 0, total_count: 0 } }));
      const { runCredsLoginCloudflare } = await import(${JSON.stringify(moduleUrl)});
      const ok = await runCredsLoginCloudflare({ account: ${JSON.stringify(ACCOUNT)} });
      process.exitCode = ok ? 0 : 1;`;
    const run = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: Process environment keys are uppercase.
        PATH: '',
        // biome-ignore lint/style/useNamingConvention: Process environment keys are uppercase.
        STANDARDS_BROKER_FILE: brokerPath,
      },
      input: `${TOKEN}\n`,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'token verification returned no valid token id',
    );
    expect(existsSync(brokerPath)).toBe(false);
  });
});

it('prints the complete Create additional tokens template sequence', () => {
  const tokensUrl = `https://dash.cloudflare.com/${ACCOUNT}/api-tokens`;
  expect(cloudflareBootstrapInstructions(tokensUrl)).toEqual([
    'Create the bootstrap token (one time for this account):',
    `  1. Open ${tokensUrl}`,
    '  2. Select Create Token',
    '  3. Find Create additional tokens and select Use template',
    `  4. Name it ${BROKER_IDENTITY_NAME}`,
    '  5. Keep exactly one permission: Account / Account API Tokens / Edit',
    '  6. Continue to summary, create the token, and copy the value',
  ]);
});
