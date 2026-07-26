// Shared harness for the policy-resolution tests: permission groups are read
// from the provider, so every case stubs that one call.

const ACCOUNT_ID_LENGTH = 32;

export const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
export const BROKER_ACCOUNT = { accountId: ACCOUNT, token: 'bootstrap' };

const originalFetch = globalThis.fetch;

export const stubGroups = (groups: ReadonlyArray<unknown>): void => {
  globalThis.fetch = ((_input: string | URL | Request) =>
    Promise.resolve(
      Response.json({ success: true, errors: [], result: groups }),
    )) as typeof fetch;
};

export const restoreFetch = (): void => {
  globalThis.fetch = originalFetch;
};
