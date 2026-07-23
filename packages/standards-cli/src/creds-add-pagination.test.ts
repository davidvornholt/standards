import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runCredsAddCloudflare } from './creds-add';

const ACCOUNT_ID_LENGTH = 32;
const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const originalBroker = process.env.STANDARDS_BROKER_FILE;
const originalFetch = globalThis.fetch;
let root = '';

const response = (
  result: ReadonlyArray<Readonly<Record<string, unknown>>>,
  page: number,
  total: number,
): Response =>
  Response.json({
    success: true,
    errors: [],
    result,
    // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
    result_info: {
      page,
      // biome-ignore lint/style/useNamingConvention: Cloudflare's pagination field is snake_case.
      per_page: 50,
      count: result.length,
      // biome-ignore lint/style/useNamingConvention: Cloudflare's pagination field is snake_case.
      total_count: total,
    },
  });

const initialize = (): string => {
  root = mkdtempSync(join(tmpdir(), 'creds-add-pages-'));
  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, 'secrets'), { recursive: true });
  writeFileSync(
    join(consumer, 'secrets', 'ci.yaml'),
    'ci:\n  token: ENC[AES256_GCM,data:x]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n',
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

describe('creds add pagination safety', () => {
  it('detects a destination collision on a later short page', async () => {
    const consumer = initialize();
    const methods: Array<string> = [];
    const pages: Array<number> = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (url.pathname.endsWith('/permission_groups')) {
        return Promise.resolve(
          Response.json({
            success: true,
            errors: [],
            result: [
              {
                id: 'pg',
                name: 'Workers Scripts Write',
                scopes: ['com.cloudflare.api.account'],
              },
            ],
          }),
        );
      }
      const page = Number(url.searchParams.get('page'));
      pages.push(page);
      return Promise.resolve(
        page === 1
          ? response([{ id: 'other', name: 'unrelated' }], 1, 2)
          : response(
              [
                {
                  id: 'collision',
                  name: 'standards/davidvornholt/example/ci/ci.token',
                },
              ],
              2,
              2,
            ),
      );
    }) as typeof fetch;
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await runCredsAddCloudflare(consumer, {
        dest: 'ci:ci.token',
        permissions: 'Workers Scripts Write',
        account: ACCOUNT,
        ttlDays: 90,
      }),
    ).toBe(false);
    expect(pages).toEqual([1, 2]);
    expect(methods).not.toContain('POST');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('already exists'),
    );
  });
});
