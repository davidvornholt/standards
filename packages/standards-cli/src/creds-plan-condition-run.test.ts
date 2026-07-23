import { afterEach, describe, expect, it, mock } from 'bun:test';
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
const EXECUTABLE_MODE = 0o755;
const DAY_MS = 86_400_000;
const TOKEN_TTL_DAYS = 90;
const RENEWAL_WINDOW_DAYS = 10;
const originalBroker = process.env.STANDARDS_BROKER_FILE;
const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
let root = '';

const initialize = (): string => {
  root = mkdtempSync(join(tmpdir(), 'creds-condition-'));
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
  writeFileSync(
    sops,
    '#!/bin/sh\nif [ "$1" = "edit" ]; then eval "$SOPS_EDITOR \\"$2\\""; exit $?; fi\nprintf \'"new-value"\'\n',
  );
  chmodSync(sops, EXECUTABLE_MODE);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
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

describe('Cloudflare request IP renewal', () => {
  it('copies in and not_in through list, plan, and replacement creation', async () => {
    const consumer = initialize();
    let creationBody: unknown;
    const expires = Date.now() + RENEWAL_WINDOW_DAYS * DAY_MS;
    globalThis.fetch = ((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        creationBody = JSON.parse(String(init?.body)) as unknown;
        return Promise.resolve(
          Response.json({
            success: true,
            errors: [],
            result: { id: 'replacement', value: 'new-value' },
          }),
        );
      }
      if (method === 'DELETE') {
        return Promise.resolve(
          Response.json({ success: true, errors: [], result: {} }),
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
              condition: {
                // biome-ignore lint/style/useNamingConvention: Cloudflare's condition wire field is snake_case.
                request_ip: {
                  in: ['192.0.2.0/24'],
                  // biome-ignore lint/style/useNamingConvention: Cloudflare's condition wire field is snake_case.
                  not_in: ['192.0.2.10/32'],
                },
              },
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
    expect(creationBody).toEqual(
      expect.objectContaining({
        condition: {
          // biome-ignore lint/style/useNamingConvention: Cloudflare's condition wire field is snake_case.
          request_ip: {
            in: ['192.0.2.0/24'],
            // biome-ignore lint/style/useNamingConvention: Cloudflare's condition wire field is snake_case.
            not_in: ['192.0.2.10/32'],
          },
        },
      }),
    );
  });
});
