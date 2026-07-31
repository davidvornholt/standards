const ACCOUNT_ID_LENGTH = 32;
const DAY_MS = 86_400_000;
const RENEWAL_WINDOW_DAYS = 10;
const TOKEN_TTL_DAYS = 90;
export const TEST_ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const originalFetch = globalThis.fetch;

const envelope = (result: unknown, info?: unknown, success = true): Response =>
  Response.json({
    success,
    errors: success ? [] : [{ message: String(result) }],
    result: success ? result : null,
    // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
    ...(info === undefined ? {} : { result_info: info }),
  });

const token = (target: string): unknown => {
  const expires = Date.now() + RENEWAL_WINDOW_DAYS * DAY_MS;
  return {
    id: `old${target}`,
    name: `standards/davidvornholt/example/${target}/r2.pair`,
    status: 'active',
    // biome-ignore lint/style/useNamingConvention: Cloudflare's token field is snake_case.
    expires_on: new Date(expires).toISOString(),
    // biome-ignore lint/style/useNamingConvention: Cloudflare's token field is snake_case.
    issued_on: new Date(expires - TOKEN_TTL_DAYS * DAY_MS).toISOString(),
    policies: [
      {
        effect: 'allow',
        resources: { [`com.cloudflare.api.account.${TEST_ACCOUNT}`]: '*' },
        // biome-ignore lint/style/useNamingConvention: Cloudflare's policy field is snake_case.
        permission_groups: [{ id: 'pg' }],
      },
    ],
  };
};

export const stubRefreshFailureCloudflare = (
  targets: ReadonlyArray<string>,
  failure: { readonly create?: string; readonly revoke?: string },
): void => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/verify')) {
      return Promise.resolve(envelope({ id: 'bootstrap', status: 'active' }));
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { readonly name: string };
      const target = targets.find((candidate) =>
        body.name.includes(`/${candidate}/`),
      );
      return Promise.resolve(
        target === failure.create
          ? envelope('creation failed', undefined, false)
          : envelope({ id: `new${target}`, value: `value-${target}` }),
      );
    }
    if (method === 'DELETE') {
      const target = targets.find((candidate) =>
        url.endsWith(`/old${candidate}`),
      );
      return Promise.resolve(
        target === failure.revoke
          ? envelope('revocation failed', undefined, false)
          : envelope({ id: 'deleted' }),
      );
    }
    const listed = [
      { id: 'bootstrap', name: 'standards-broker', status: 'active' },
      ...targets.map(token),
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

export const resetRefreshFailureCloudflare = (): void => {
  globalThis.fetch = originalFetch;
};
