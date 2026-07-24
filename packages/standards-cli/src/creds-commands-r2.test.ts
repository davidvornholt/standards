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

afterEach(cleanupCredsAdd);

describe('public creds R2 routing', () => {
  it('rejects --s3 without --bucket before provider or SOPS mutation', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const methods: Array<string> = [];
    globalThis.fetch = ((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      methods.push(init?.method ?? 'GET');
      return Promise.resolve(response([], pageInfo(0, 0)));
    }) as typeof fetch;
    installSops('touch "$PWD/sops-called"\nexit 1');
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await runCredsCommand([
        'add',
        'cloudflare',
        '--dir',
        consumer,
        '--dest',
        'ci:ci.r2',
        '--s3',
        '--permissions',
        'Workers Scripts Write',
      ]),
    ).toBe(false);
    expect(methods).toEqual([]);
    expect(existsSync(join(consumer, 'sops-called'))).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('--s3 requires --bucket'),
    );
  });

  it('routes an EU bucket S3 request to matching policy and endpoint forms', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const bodies: Array<unknown> = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('permission_groups')) {
        return Promise.resolve(
          response([
            {
              id: 'r2-read',
              name: 'Workers R2 Storage Bucket Item Read',
              scopes: ['com.cloudflare.edge.r2.bucket'],
            },
          ]),
        );
      }
      if (method === 'POST') {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(
          response({ id: 'replacement', value: 'sensitive-token-value' }),
        );
      }
      return Promise.resolve(response([], pageInfo(0, 0)));
    }) as typeof fetch;
    installSops(
      'if [ "$1" = "decrypt" ]; then case "$3" in *access_key_id*) printf \'"replacement"\' ;; *) printf \'"5776f573ef7db2824f9f28c4c9d033f1e56890a339a7a2057d3f273243fcd9c5"\' ;; esac; exit 0; fi\neval "$SOPS_EDITOR \\"$2\\""',
    );
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    expect(
      await runCredsCommand([
        'add',
        'cloudflare',
        '--dir',
        consumer,
        '--dest',
        'ci:ci.r2',
        '--bucket',
        'assets',
        '--jurisdiction',
        'eu',
        '--s3',
        '--permissions',
        'Workers R2 Storage Bucket Item Read',
      ]),
    ).toBe(true);
    expect(bodies[0]).toMatchObject({
      policies: [
        {
          resources: {
            [`com.cloudflare.edge.r2.bucket.${ACCOUNT_A}_eu_assets`]: '*',
          },
        },
      ],
    });
    expect(log.mock.calls.join(' ')).toContain(
      `https://${ACCOUNT_A}.eu.r2.cloudflarestorage.com`,
    );
  });

  it('rejects an unsupported jurisdiction during public argument parsing', () => {
    globalThis.fetch = ((_input: string | URL | Request): Promise<Response> => {
      throw new Error('no provider call expected');
    }) as typeof fetch;
    expect(() =>
      runCredsCommand(['add', 'cloudflare', '--jurisdiction', 'fedramp']),
    ).toThrow('--jurisdiction must be default or eu');
  });
});
