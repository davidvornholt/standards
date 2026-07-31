const ACCOUNT_ID_LENGTH = 32;
const DAY_MS = 86_400_000;
const RENEWAL_WINDOW_DAYS = 10;
const TOKEN_TTL_DAYS = 90;
export const TEST_ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const originalFetch = globalThis.fetch;
const calls: Array<string> = [];

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

type StubFailure = {
  readonly create?: string;
  readonly rejectCreate?: string;
  readonly rejectRevoke?: string;
  readonly revoke?: string;
};

type CreationRejectionGate = {
  oldDeletionObserved: boolean;
  rejectPendingCreation: (() => void) | null;
};

const createResponse = (
  targets: ReadonlyArray<string>,
  failure: StubFailure,
  gate: CreationRejectionGate,
  init: RequestInit | undefined,
): Promise<Response> => {
  const body = JSON.parse(String(init?.body)) as { readonly name: string };
  const target = targets.find((candidate) =>
    body.name.includes(`/${candidate}/`),
  );
  calls.push(`create-${target}`);
  if (failure.rejectCreate === undefined || target !== failure.rejectCreate) {
    return Promise.resolve(
      target === failure.create
        ? envelope('creation failed', undefined, false)
        : envelope({ id: `new${target}`, value: `value-${target}` }),
    );
  }
  return new Promise((_resolve, reject) => {
    const rejectCreation = () => {
      reject(new Error(`creation transport failed: ${target}`));
    };
    if (gate.oldDeletionObserved) {
      rejectCreation();
    } else {
      gate.rejectPendingCreation = rejectCreation;
    }
  });
};

const deleteResponse = (
  targets: ReadonlyArray<string>,
  failure: StubFailure,
  gate: CreationRejectionGate,
  url: string,
): Promise<Response> => {
  const target = targets.find((candidate) => url.endsWith(`/old${candidate}`));
  const tokenId = url.slice(url.lastIndexOf('/') + 1);
  calls.push(`delete-${tokenId}`);
  if (failure.rejectRevoke !== undefined && target === failure.rejectRevoke) {
    return Promise.reject(new Error(`revocation transport failed: ${target}`));
  }
  if (target !== undefined) {
    gate.oldDeletionObserved = true;
    gate.rejectPendingCreation?.();
    gate.rejectPendingCreation = null;
  }
  return Promise.resolve(
    target === failure.revoke
      ? envelope('revocation failed', undefined, false)
      : envelope({ id: 'deleted' }),
  );
};

export const stubRefreshFailureCloudflare = (
  targets: ReadonlyArray<string>,
  failure: StubFailure,
): void => {
  const gate: CreationRejectionGate = {
    oldDeletionObserved: false,
    rejectPendingCreation: null,
  };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/verify')) {
      return Promise.resolve(envelope({ id: 'bootstrap', status: 'active' }));
    }
    if (method === 'POST') {
      return createResponse(targets, failure, gate, init);
    }
    if (method === 'DELETE') {
      return deleteResponse(targets, failure, gate, url);
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
  calls.length = 0;
};

export const refreshFailureCloudflareCalls = (): ReadonlyArray<string> => calls;
