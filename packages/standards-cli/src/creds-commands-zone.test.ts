import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCOUNT_A,
  cleanupCredsAdd,
  initializeConsumer,
  installSops,
  pageInfo,
  response,
} from './creds-add-test-support';
import { runCredsCommand } from './creds-commands';

const ZONE_ID_LENGTH = 32;
const ZONE_A = `1${'b'.repeat(ZONE_ID_LENGTH - 1)}`;
const ZONE_B = `2${'c'.repeat(ZONE_ID_LENGTH - 1)}`;

const refuseProviderCalls = (): Array<string> => {
  const methods: Array<string> = [];
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    return Promise.resolve(response([], pageInfo(0, 0)));
  }) as typeof fetch;
  return methods;
};

afterEach(cleanupCredsAdd);

describe('public creds zone routing', () => {
  it('mints one token carrying an account policy and a zone policy', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const bodies: Array<unknown> = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('permission_groups')) {
        return Promise.resolve(
          response([
            {
              id: 'dns-write',
              name: 'DNS Write',
              scopes: ['com.cloudflare.api.account.zone'],
            },
            {
              id: 'workers-write',
              name: 'Workers Scripts Write',
              scopes: ['com.cloudflare.api.account'],
            },
          ]),
        );
      }
      if (method === 'POST') {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(
          response({ id: 'minted', value: 'sensitive-token-value' }),
        );
      }
      return Promise.resolve(response([], pageInfo(0, 0)));
    }) as typeof fetch;
    installSops(
      'if [ "$1" = "decrypt" ]; then printf \'sensitive-token-value\'; exit 0; fi\neval "$SOPS_EDITOR \\"$2\\""',
    );
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    expect(
      await runCredsCommand([
        'add',
        'cloudflare',
        '--dir',
        consumer,
        '--dest',
        'ci:ci.dns',
        '--zone',
        `${ZONE_A},${ZONE_B}`,
        '--permissions',
        'Workers Scripts Write,DNS Write',
      ]),
    ).toBe(true);
    expect(bodies[0]).toMatchObject({
      policies: [
        {
          resources: { [`com.cloudflare.api.account.${ACCOUNT_A}`]: '*' },
          // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
          permission_groups: [{ id: 'workers-write' }],
        },
        {
          resources: {
            [`com.cloudflare.api.account.zone.${ZONE_A}`]: '*',
            [`com.cloudflare.api.account.zone.${ZONE_B}`]: '*',
          },
          // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
          permission_groups: [{ id: 'dns-write' }],
        },
      ],
    });
    // The account policy is the wider half of that token, so the operator sees
    // it in the summary rather than inferring it from the flag.
    expect(log.mock.calls.join(' ')).toContain(
      `resources: account ${ACCOUNT_A}, zone(s) ${ZONE_A}, ${ZONE_B}`,
    );
  });
});

describe('public creds zone rejections', () => {
  it('rejects --bucket with --zone before provider or SOPS mutation', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const methods = refuseProviderCalls();
    installSops('touch "$PWD/sops-called"\nexit 1');
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await runCredsCommand([
        'add',
        'cloudflare',
        '--dir',
        consumer,
        '--dest',
        'ci:ci.dns',
        '--bucket',
        'assets',
        '--zone',
        ZONE_A,
        '--permissions',
        'DNS Write',
      ]),
    ).toBe(false);
    expect(methods).toEqual([]);
    expect(existsSync(join(consumer, 'sops-called'))).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('--bucket and --zone cannot be combined'),
    );
  });

  it('rejects a zone named by domain before provider or SOPS mutation', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const methods = refuseProviderCalls();
    installSops('touch "$PWD/sops-called"\nexit 1');
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await runCredsCommand([
        'add',
        'cloudflare',
        '--dir',
        consumer,
        '--dest',
        'ci:ci.dns',
        '--zone',
        'example.test',
        '--permissions',
        'DNS Write',
      ]),
    ).toBe(false);
    expect(methods).toEqual([]);
    expect(existsSync(join(consumer, 'sops-called'))).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('not a zone ID: example.test'),
    );
  });
});
