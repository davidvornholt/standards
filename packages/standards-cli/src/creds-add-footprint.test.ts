import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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

const S3_SECRETS =
  'ci:\n  r2:\n    access_key_id: ENC[AES256_GCM,data:a]\n    secret_access_key: ENC[AES256_GCM,data:b]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n';
const ABSENT_S3_SECRETS =
  'ci:\n  token: ENC[AES256_GCM,data:x]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n';

afterEach(cleanupCredsAdd);

type CollisionCase = {
  readonly accounts: ReadonlyArray<string>;
  readonly candidateKey: string;
  readonly existingAccount: string;
  readonly existingKey: string;
  readonly s3: boolean;
  readonly secrets: string;
};

const collisionOutcome = async ({
  accounts,
  candidateKey,
  existingAccount,
  existingKey,
  s3,
  secrets,
}: CollisionCase): Promise<{
  readonly ok: boolean;
  readonly mutated: boolean;
  readonly reportedFootprint: boolean;
}> => {
  const consumer = initializeConsumer(accounts, secrets);
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
    const tokens = url.includes(`/accounts/${existingAccount}/tokens`)
      ? [
          {
            id: 'existing',
            name: `standards/davidvornholt/example/ci/${existingKey}`,
            status: 'active',
          },
        ]
      : [];
    return Promise.resolve(
      response(tokens, pageInfo(tokens.length, tokens.length)),
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
      expect(
        await collisionOutcome({
          accounts: [ACCOUNT_A],
          candidateKey: 'ci.r2',
          existingAccount: ACCOUNT_A,
          existingKey: `ci.r2.${leaf}`,
          s3: true,
          secrets: S3_SECRETS,
        }),
      ).toEqual({
        ok: false,
        mutated: false,
        reportedFootprint: true,
      });
    });

    it(`rejects a ${leaf} bearer that intersects an existing S3 base`, async () => {
      expect(
        await collisionOutcome({
          accounts: [ACCOUNT_A],
          candidateKey: `ci.r2.${leaf}`,
          existingAccount: ACCOUNT_A,
          existingKey: 'ci.r2',
          s3: false,
          secrets: S3_SECRETS,
        }),
      ).toEqual({
        ok: false,
        mutated: false,
        reportedFootprint: true,
      });
    });
  }

  for (const existingAccount of [ACCOUNT_A, ACCOUNT_B]) {
    const accountScope =
      existingAccount === ACCOUNT_A ? 'same account' : 'other account';

    it(`rejects an exact S3 destination in the ${accountScope} when its pair is absent`, async () => {
      expect(
        await collisionOutcome({
          accounts:
            existingAccount === ACCOUNT_A
              ? [ACCOUNT_A]
              : [ACCOUNT_A, ACCOUNT_B],
          candidateKey: 'ci.r2',
          existingAccount,
          existingKey: 'ci.r2',
          s3: true,
          secrets: ABSENT_S3_SECRETS,
        }),
      ).toEqual({
        ok: false,
        mutated: false,
        reportedFootprint: true,
      });
    });
  }
});
