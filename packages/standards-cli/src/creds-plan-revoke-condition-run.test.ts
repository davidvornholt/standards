import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runCredsPlan } from './creds-plan-run';

const ACCOUNT_ID_LENGTH = 32;
const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const originalBroker = process.env.STANDARDS_BROKER_FILE;
const originalFetch = globalThis.fetch;
let root = '';

const initialize = (): string => {
  root = mkdtempSync(join(tmpdir(), 'creds-revoke-condition-'));
  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, 'secrets'), { recursive: true });
  writeFileSync(
    join(consumer, 'secrets', 'ci.yaml'),
    'ci:\n  other: ENC[AES256_GCM,data:x]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n',
  );
  execFileSync('git', ['init', '-q', consumer]);
  execFileSync('git', [
    '-C',
    consumer,
    'remote',
    'add',
    'origin',
    'git@github.com:davidvornholt/example.git',
  ]);
  const broker = join(root, 'broker.yaml');
  writeFileSync(
    broker,
    `cloudflare:\n  - account_id: ${ACCOUNT}\n    token: bootstrap\n`,
  );
  process.env.STANDARDS_BROKER_FILE = broker;
  return consumer;
};

afterEach(() => {
  mock.restore();
  globalThis.fetch = originalFetch;
  if (originalBroker === undefined) {
    delete process.env.STANDARDS_BROKER_FILE;
  } else {
    process.env.STANDARDS_BROKER_FILE = originalBroker;
  }
  if (root.length > 0) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Cloudflare orphan revocation', () => {
  it('deletes an absent credential with an unknown condition without replacement', async () => {
    const consumer = initialize();
    const methods: Array<string> = [];
    globalThis.fetch = ((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'DELETE') {
        return Promise.resolve(
          Response.json({ success: true, errors: [], result: {} }),
        );
      }
      if (method === 'POST') {
        return Promise.resolve(
          Response.json({
            success: true,
            errors: [],
            result: { id: 'replacement', value: 'new-value' },
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          success: true,
          errors: [],
          result: [
            {
              id: 'old',
              name: 'standards/davidvornholt/example/ci/ci.token',
              status: 'active',
              // biome-ignore lint/style/useNamingConvention: this deliberately unknown Cloudflare wire field must fail condition decoding.
              condition: { future_shape: true },
            },
          ],
          // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
          result_info: {
            page: 1,
            // biome-ignore lint/style/useNamingConvention: Cloudflare's pagination field is snake_case.
            per_page: 50,
            count: 1,
            // biome-ignore lint/style/useNamingConvention: Cloudflare's pagination field is snake_case.
            total_count: 1,
          },
        }),
      );
    }) as typeof fetch;
    expect(await runCredsPlan(consumer, true)).toBe(true);
    expect(methods).toEqual(['GET', 'DELETE']);
  });
});
