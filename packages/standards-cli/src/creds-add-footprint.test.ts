import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
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

const S3_SECRETS =
  'ci:\n  r2:\n    access_key_id: ENC[AES256_GCM,data:a]\n    secret_access_key: ENC[AES256_GCM,data:b]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n';

afterEach(cleanupCredsAdd);

const collisionOutcome = async (
  candidateKey: string,
  s3: boolean,
  existingKey: string,
): Promise<{
  readonly ok: boolean;
  readonly mutated: boolean;
  readonly reportedFootprint: boolean;
}> => {
  const consumer = initializeConsumer([ACCOUNT_A], S3_SECRETS);
  installSops('touch "$PWD/sops-called"\nexit 1');
  const methods: Array<string> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    methods.push(method);
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
    return Promise.resolve(
      response(
        [
          {
            id: 'existing',
            name: `standards/davidvornholt/example/ci/${existingKey}`,
            status: 'active',
          },
        ],
        pageInfo(1, 1),
      ),
    );
  }) as typeof fetch;
  const error = spyOn(console, 'error').mockImplementation(() => undefined);
  const ok = await runCredsAddCloudflare(consumer, {
    dest: `ci:${candidateKey}`,
    permissions: 'Workers R2 Storage Bucket Item Read',
    account: ACCOUNT_A,
    ttlDays: 90,
    bucket: 'assets',
    s3,
  });
  return {
    ok,
    mutated:
      methods.includes('POST') ||
      methods.includes('DELETE') ||
      existsSync(join(consumer, 'sops-called')),
    reportedFootprint: error.mock.calls
      .flat()
      .some((value) => String(value).includes('destination footprint')),
  };
};

describe('creds add destination footprint collisions', () => {
  for (const leaf of ['access_key_id', 'secret_access_key']) {
    it(`rejects an S3 base that intersects an existing ${leaf} bearer`, async () => {
      expect(await collisionOutcome('ci.r2', true, `ci.r2.${leaf}`)).toEqual({
        ok: false,
        mutated: false,
        reportedFootprint: true,
      });
    });

    it(`rejects a ${leaf} bearer that intersects an existing S3 base`, async () => {
      expect(await collisionOutcome(`ci.r2.${leaf}`, false, 'ci.r2')).toEqual({
        ok: false,
        mutated: false,
        reportedFootprint: true,
      });
    });
  }
});
