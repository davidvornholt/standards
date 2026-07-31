import { createHash } from 'node:crypto';
import type { RefreshMixedKind } from './creds-plan-refresh-mixed-test-support';

const ACCOUNT_ID_LENGTH = 32;
const DAY_MS = 86_400_000;
const RENEWAL_WINDOW_DAYS = 10;
const TOKEN_TTL_DAYS = 90;
export const MIXED_TEST_ACCOUNT = 'b'.repeat(ACCOUNT_ID_LENGTH);
const originalFetch = globalThis.fetch;
const calls: Array<string> = [];

const envelope = (result: unknown, info?: unknown): Response =>
  Response.json({
    success: true,
    errors: [],
    result,
    // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
    ...(info === undefined ? {} : { result_info: info }),
  });

const token = (key: string, id: string): unknown => {
  const expires = Date.now() + RENEWAL_WINDOW_DAYS * DAY_MS;
  return {
    id,
    name: `standards/davidvornholt/example/ci/${key}`,
    status: 'active',
    // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
    expires_on: new Date(expires).toISOString(),
    // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
    issued_on: new Date(expires - TOKEN_TTL_DAYS * DAY_MS).toISOString(),
    policies: [
      {
        effect: 'allow',
        resources: {
          [`com.cloudflare.api.account.${MIXED_TEST_ACCOUNT}`]: '*',
        },
        // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
        permission_groups: [{ id: 'pg' }],
      },
    ],
  };
};

const destination = (name: string): 'api' | 'bad' | 'good' => {
  if (name.endsWith('/api.token')) {
    return 'api';
  }
  return name.endsWith('/r2.good') ? 'good' : 'bad';
};

export const mixedSecret = (name: string): string =>
  createHash('sha256').update(`value-${name}`).digest('hex');

export const stubRefreshMixedCloudflare = (kind: RefreshMixedKind): void => {
  const destinations = kind === 'bearer-s3' ? ['bad', 'api'] : ['bad', 'good'];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/verify')) {
      return Promise.resolve(envelope({ id: 'bootstrap', status: 'active' }));
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { readonly name: string };
      const name = destination(body.name);
      calls.push(`create-${name}`);
      return Promise.resolve(
        envelope({ id: `new-${name}`, value: `value-${name}` }),
      );
    }
    if (method === 'DELETE') {
      const id = url.slice(url.lastIndexOf('/') + 1);
      calls.push(`delete-${id}`);
      return Promise.resolve(envelope({ id: 'deleted' }));
    }
    const listed = [
      { id: 'bootstrap', name: 'standards-broker', status: 'active' },
      ...destinations.map((name) =>
        token(name === 'api' ? 'api.token' : `r2.${name}`, `old-${name}`),
      ),
    ];
    return Promise.resolve(
      envelope(listed, {
        page: 1,
        // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
        per_page: 50,
        count: listed.length,
        // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
        total_count: listed.length,
      }),
    );
  }) as typeof fetch;
};

export const refreshMixedCloudflareCalls = (): ReadonlyArray<string> => calls;

export const resetRefreshMixedCloudflare = (): void => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
};
