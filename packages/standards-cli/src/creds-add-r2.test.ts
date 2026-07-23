import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCredsAddCloudflare } from './creds-add';
import {
  ACCOUNT_A,
  cleanupCredsAdd,
  initializeConsumer,
  installSops,
  pageInfo,
  response,
} from './creds-add-test-support';

const WHOLE_SECOND_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

afterEach(cleanupCredsAdd);

describe('creds add cloudflare R2 S3 destinations', () => {
  // Provider ground truth: https://developers.cloudflare.com/r2/api/tokens/
  // printf '%s' 'sensitive-token-value' | sha256sum
  const sensitiveSha =
    '5776f573ef7db2824f9f28c4c9d033f1e56890a339a7a2057d3f273243fcd9c5';

  it('mints a bucket-scoped token and writes the derived S3 pair', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    installSops(
      `if [ "$1" = "decrypt" ]; then\n  case "$3" in\n    *access_key_id*) printf '"replacement"' ;;\n    *) printf '"${sensitiveSha}"' ;;\n  esac\n  exit 0\nfi\neval "$SOPS_EDITOR \\"$2\\""`,
    );
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
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const ok = await runCredsAddCloudflare(consumer, {
      dest: 'ci:ci.r2',
      permissions: 'Workers R2 Storage Bucket Item Read',
      account: ACCOUNT_A,
      ttlDays: 30,
      bucket: 'my-bucket',
      s3: true,
    });
    expect(ok).toBe(true);
    expect(bodies[0]).toMatchObject({
      policies: [
        {
          effect: 'allow',
          resources: {
            [`com.cloudflare.edge.r2.bucket.${ACCOUNT_A}_default_my-bucket`]:
              '*',
          },
          // biome-ignore lint/style/useNamingConvention: Cloudflare's policy wire field is snake_case.
          permission_groups: [{ id: 'r2-read' }],
        },
      ],
    });
    const createBody = bodies[0] as {
      // biome-ignore lint/style/useNamingConvention: Cloudflare's request field is snake_case.
      readonly expires_on: string;
    };
    expect(createBody.expires_on).toMatch(WHOLE_SECOND_RFC3339);
    const secrets = readFileSync(join(consumer, 'secrets', 'ci.yaml'), 'utf8');
    expect(secrets).toContain('access_key_id: replacement');
    expect(secrets).toContain(`secret_access_key: ${sensitiveSha}`);
    const printed = log.mock.calls.join(' ');
    expect(printed).toContain(`https://${ACCOUNT_A}.r2.cloudflarestorage.com`);
    expect(printed).not.toContain('sensitive-token-value');
  });

  it('rejects account-scoped groups when --bucket is given', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const methods: Array<string> = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      if (String(input).includes('permission_groups')) {
        return Promise.resolve(
          response([
            {
              id: 'account',
              name: 'Workers R2 Storage Read',
              scopes: ['com.cloudflare.api.account'],
            },
          ]),
        );
      }
      return Promise.resolve(response([], pageInfo(0, 0)));
    }) as typeof fetch;
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const ok = await runCredsAddCloudflare(consumer, {
      dest: 'ci:ci.r2',
      permissions: 'Workers R2 Storage Read',
      account: ACCOUNT_A,
      ttlDays: 30,
      bucket: 'my-bucket',
      s3: true,
    });
    expect(ok).toBe(false);
    expect(methods).not.toContain('POST');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('cannot target an R2 bucket resource'),
    );
  });
});
