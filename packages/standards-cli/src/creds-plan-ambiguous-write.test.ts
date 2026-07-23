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
import { runCredsPlan } from './creds-plan-run';

const ACCOUNT_ID_LENGTH = 32;
const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const DAY_MS = 86_400_000;
const TOKEN_TTL_DAYS = 90;
const EXECUTABLE_MODE = 0o755;
const originalBroker = process.env.STANDARDS_BROKER_FILE;
const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
let root = '';
let deletes: Array<string> = [];

const initialize = (sopsBody: string): string => {
  root = mkdtempSync(join(tmpdir(), 'creds-plan-ambiguous-'));
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
  deletes = [];
  const expires = Date.now() + 10 * DAY_MS;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/verify')) {
      return Promise.resolve(
        Response.json({
          success: true,
          errors: [],
          result: { id: 'bootstrap', status: 'active' },
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
    if (method === 'DELETE') {
      deletes.push(url.endsWith('/old') ? 'old' : 'replacement');
      return Promise.resolve(
        Response.json({ success: true, errors: [], result: {} }),
      );
    }
    return Promise.resolve(
      Response.json({
        success: true,
        errors: [],
        result: [
          { id: 'bootstrap', name: 'standards-broker', status: 'active' },
          {
            id: 'old',
            name: 'standards/davidvornholt/example/ci/ci.token',
            status: 'active',
            // biome-ignore lint/style/useNamingConvention: Cloudflare's token field is snake_case.
            expires_on: new Date(expires).toISOString(),
            // biome-ignore lint/style/useNamingConvention: Cloudflare's token field is snake_case.
            issued_on: new Date(
              expires - TOKEN_TTL_DAYS * DAY_MS,
            ).toISOString(),
            policies: [
              {
                effect: 'allow',
                resources: {
                  [`com.cloudflare.api.account.${ACCOUNT}`]: '*',
                },
                // biome-ignore lint/style/useNamingConvention: Cloudflare's policy field is snake_case.
                permission_groups: [{ id: 'pg' }],
              },
            ],
          },
        ],
        // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
        result_info: { page: 1, per_page: 50, count: 2, total_count: 2 },
      }),
    );
  }) as typeof fetch;
  return consumer;
};

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

describe('creds renewal ambiguous SOPS outcomes', () => {
  it('revokes only the old token after proving a late write committed', async () => {
    const consumer = initialize(
      'if [ "$1" = "edit" ]; then eval "$SOPS_EDITOR \\"$2\\""; exit 1; fi\nprintf \'"new-value"\'',
    );
    expect(await runCredsPlan(consumer, true)).toBe(true);
    expect(deletes).toEqual(['old']);
  });

  it('leaves both tokens active when post-write verification fails', async () => {
    const consumer = initialize(
      'if [ "$1" = "edit" ]; then eval "$SOPS_EDITOR \\"$2\\""; exit $?; fi\nexit 1',
    );
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsPlan(consumer, true)).toBe(false);
    expect(deletes).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        `account ${ACCOUNT} replacement replacement and old token old`,
      ),
    );
  });
});
