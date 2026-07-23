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
import { runCredsAddCloudflare } from './creds-add';

const ACCOUNT_ID_LENGTH = 32;
const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const EXECUTABLE_MODE = 0o755;
const originalBroker = process.env.STANDARDS_BROKER_FILE;
const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
let root = '';
let methods: Array<string> = [];

const initialize = (sopsBody: string): string => {
  root = mkdtempSync(join(tmpdir(), 'creds-add-ambiguous-'));
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
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const sops = join(bin, 'sops');
  writeFileSync(sops, `#!/bin/sh\n${sopsBody}\n`);
  chmodSync(sops, EXECUTABLE_MODE);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  methods = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    methods.push(method);
    if (url.includes('permission_groups')) {
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
        result: [],
        // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
        result_info: { page: 1, per_page: 50, count: 0, total_count: 0 },
      }),
    );
  }) as typeof fetch;
  return consumer;
};

const run = (consumer: string): Promise<boolean> =>
  runCredsAddCloudflare(consumer, {
    dest: 'ci:ci.token',
    permissions: 'Workers Scripts Write',
    account: ACCOUNT,
    ttlDays: 90,
  });

afterEach(() => {
  mock.restore();
  globalThis.fetch = originalFetch;
  process.env.PATH = originalPath;
  if (originalBroker === undefined) {
    delete process.env.STANDARDS_BROKER_FILE;
  } else {
    process.env.STANDARDS_BROKER_FILE = originalBroker;
  }
  if (root.length > 0) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('creds add ambiguous SOPS outcomes', () => {
  it('retains a replacement committed before a late editor failure', async () => {
    const consumer = initialize(
      'if [ "$1" = "edit" ]; then eval "$SOPS_EDITOR \\"$2\\""; exit 1; fi\nprintf \'"new-value"\'',
    );
    expect(await run(consumer)).toBe(true);
    expect(methods).not.toContain('DELETE');
  });

  it('retains the replacement when post-write verification fails', async () => {
    const consumer = initialize(
      'if [ "$1" = "edit" ]; then eval "$SOPS_EDITOR \\"$2\\""; exit $?; fi\nexit 1',
    );
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(consumer)).toBe(false);
    expect(methods).not.toContain('DELETE');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('replacement'));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('remains active'),
    );
  });
});
