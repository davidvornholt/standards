import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runCredsAddCloudflare, unsupportedAccountScopes } from './creds-add';

const ACCOUNT_ID_LENGTH = 32;
const ACCOUNT_A = 'a'.repeat(ACCOUNT_ID_LENGTH);
const ACCOUNT_B = 'b'.repeat(ACCOUNT_ID_LENGTH);
const EXECUTABLE_MODE = 0o755;
const originalFetch = globalThis.fetch;
const originalBroker = process.env.STANDARDS_BROKER_FILE;
const originalPath = process.env.PATH;
let root = '';
const response = (result: unknown, info?: unknown): Response =>
  Response.json({
    success: true,
    errors: [],
    result,
    // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
    ...(info === undefined ? {} : { result_info: info }),
  });

const pageInfo = (count: number, totalCount: number): unknown => ({
  page: 1,
  // biome-ignore lint/style/useNamingConvention: Cloudflare's pagination field is snake_case.
  per_page: 50,
  count,
  // biome-ignore lint/style/useNamingConvention: Cloudflare's pagination field is snake_case.
  total_count: totalCount,
});
const initializeConsumer = (accounts: ReadonlyArray<string>): string => {
  root = mkdtempSync(join(tmpdir(), 'creds-add-'));
  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, 'secrets'), { recursive: true });
  writeFileSync(
    join(consumer, 'secrets', 'ci.yaml'),
    'ci:\n  token: ENC[AES256_GCM,data:x]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n  version: 3.9.4\n',
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
    `cloudflare:\n${accounts.map((account) => `  - account_id: ${account}\n    token: bootstrap-${account}`).join('\n')}\n`,
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
  process.env.PATH = originalPath;
  if (root.length > 0) {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    });
    expect(ok).toBe(false);
    expect(methods).not.toContain('POST');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'one SOPS destination may be managed by only one account',
      ),
    );
  });

  it('rejects groups without a supported account scope', () => {
    expect(
      unsupportedAccountScopes([
        {
          id: 'zone',
          name: 'DNS Write',
          scopes: ['com.cloudflare.api.account.zone'],
        },
        {
          id: 'account',
          name: 'Workers Scripts Write',
          scopes: ['com.cloudflare.api.account'],
        },
      ]),
    ).toEqual(['DNS Write']);
  });
});

describe('creds add cloudflare compensation', () => {
  it('deletes a just-created token when the SOPS write fails', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const sops = join(bin, 'sops');
    writeFileSync(
      sops,
      '#!/bin/sh\nif [ "$1" = "decrypt" ]; then printf \'"old-value"\'; exit 0; fi\nexit 1\n',
    );
    chmodSync(sops, EXECUTABLE_MODE);
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
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
