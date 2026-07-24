import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { runCredsAddCloudflare } from './creds-add';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  cleanupCredsAdd,
  initializeConsumer,
  installSops,
  pageInfo,
  response,
} from './creds-add-test-support';

afterEach(cleanupCredsAdd);

describe('creds add cloudflare', () => {
  it('rejects a cross-account destination collision before creation', async () => {
    const consumer = initializeConsumer([ACCOUNT_A, ACCOUNT_B]);
    const methods: Array<string> = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      methods.push(init?.method ?? 'GET');
      if (url.includes('permission_groups')) {
        return Promise.resolve(
          response([
            {
              id: 'pg',
              name: 'Workers Scripts Write',
              scopes: ['com.cloudflare.api.account'],
            },
          ]),
        );
      }
      const collision = url.includes(`/accounts/${ACCOUNT_B}/tokens`);
      return Promise.resolve(
        response(
          collision
            ? [
                {
                  id: 'existing',
                  name: 'standards/davidvornholt/example/ci/ci.token',
                  status: 'active',
                },
              ]
            : [],
          pageInfo(collision ? 1 : 0, collision ? 1 : 0),
        ),
      );
    }) as typeof fetch;
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const ok = await runCredsAddCloudflare(consumer, {
      dest: 'ci:ci.token',
      permissions: 'Workers Scripts Write',
      account: ACCOUNT_A,
      ttlDays: 90,
      bucket: undefined,
      s3: false,
    });
    expect(ok).toBe(false);
    expect(methods).not.toContain('POST');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'one SOPS destination may be managed by only one account',
      ),
    );
  });
});

describe('creds add cloudflare compensation', () => {
  it('deletes a just-created token when the SOPS write fails', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    installSops(
      'if [ "$1" = "decrypt" ]; then printf \'"old-value"\'; exit 0; fi\nexit 1',
    );
    const methods: Array<string> = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (url.includes('permission_groups')) {
        return Promise.resolve(
          response([
            {
              id: 'pg',
              name: 'Workers Scripts Write',
              scopes: ['com.cloudflare.api.account'],
            },
          ]),
        );
      }
      if (method === 'POST') {
        return Promise.resolve(
          response({ id: 'replacement', value: 'sensitive-token-value' }),
        );
      }
      if (method === 'DELETE') {
        return Promise.resolve(response({ id: 'replacement' }));
      }
      return Promise.resolve(response([], pageInfo(0, 0)));
    }) as typeof fetch;
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const ok = await runCredsAddCloudflare(consumer, {
      dest: 'ci:ci.token',
      permissions: 'Workers Scripts Write',
      account: ACCOUNT_A,
      ttlDays: 90,
      bucket: undefined,
      s3: false,
    });
    expect(ok).toBe(false);
    expect(methods).toContain('POST');
    expect(methods).toContain('DELETE');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('deleted replacement token replacement'),
    );
    expect(error.mock.calls.join(' ')).not.toContain('sensitive-token-value');
  });
});
