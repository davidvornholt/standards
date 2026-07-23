// Shared harness for the plan/apply run suites: a git consumer with an
// encrypted-shaped secrets file, a broker store env override, a scripted
// `sops` shim on PATH, a Cloudflare fetch stub that journals mutations to an
// event file, and a cleanup that restores every global it touched.

import { mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const ACCOUNT_ID_LENGTH = 32;
export const ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const EXECUTABLE_MODE = 0o755;
const DAY_MS = 86_400_000;
const TOKEN_TTL_DAYS = 90;
const RENEWAL_WINDOW_DAYS = 10;
export const ENCRYPTED_SECRETS =
  'ci:\n  token: ENC[AES256_GCM,data:x]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n';

const originalBroker = process.env.STANDARDS_BROKER_FILE;
const originalEventFile = process.env.PLAN_EVENT_FILE;
const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
let root = '';

export const planRunRoot = (): string => root;

export const initialize = (
  secrets: string,
): { consumer: string; events: string } => {
  root = mkdtempSync(join(tmpdir(), 'creds-plan-run-'));
  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, 'secrets'), { recursive: true });
  writeFileSync(join(consumer, 'secrets', 'ci.yaml'), secrets);
  execFileSync('git', ['init', '-q', consumer]);
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'git@github.com:davidvornholt/example.git'],
    { cwd: consumer },
  );
  const broker = join(root, 'broker.yaml');
  const brokerContent = `cloudflare:\n  - account_id: ${ACCOUNT}\n    token: bootstrap\n`;
  writeFileSync(broker, brokerContent);
  const events = join(root, 'events');
  writeFileSync(events, '');
  process.env.STANDARDS_BROKER_FILE = broker;
  process.env.PLAN_EVENT_FILE = events;
  return { consumer, events };
};

export const installSops = (body: string): void => {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const path = join(bin, 'sops');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, EXECUTABLE_MODE);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
};

const expiringToken = (target: string): unknown => {
  const expires = Date.now() + RENEWAL_WINDOW_DAYS * DAY_MS;
  return {
    id: 'old',
    name: `standards/davidvornholt/example/${target}/ci.token`,
    status: 'active',
    // biome-ignore lint/style/useNamingConvention: Cloudflare's token field is snake_case.
    expires_on: new Date(expires).toISOString(),
    // biome-ignore lint/style/useNamingConvention: Cloudflare's token field is snake_case.
    issued_on: new Date(expires - TOKEN_TTL_DAYS * DAY_MS).toISOString(),
    policies: [
      {
        effect: 'allow',
        resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: '*' },
        // biome-ignore lint/style/useNamingConvention: Cloudflare's policy field is snake_case.
        permission_groups: [{ id: 'pg' }],
      },
    ],
  };
};

const envelope = (result: unknown, info?: unknown): Response =>
  Response.json({
    success: true,
    errors: [],
    result,
    // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
    ...(info === undefined ? {} : { result_info: info }),
  });

const pageInfo = (count: number): unknown => ({
  page: 1,
  // biome-ignore lint/style/useNamingConvention: Cloudflare's pagination field is snake_case.
  per_page: 50,
  count,
  // biome-ignore lint/style/useNamingConvention: Cloudflare's pagination field is snake_case.
  total_count: count,
});

export const stubCloudflare = (
  target = 'ci',
  verifiedId: string | null = 'bootstrap',
): void => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/verify')) {
      return Promise.resolve(
        envelope({
          ...(verifiedId === null ? {} : { id: verifiedId }),
          status: 'active',
        }),
      );
    }
    if (method === 'POST') {
      appendFileSync(process.env.PLAN_EVENT_FILE ?? '', 'create\n');
      return Promise.resolve(
        envelope({ id: 'replacement', value: 'new-value' }),
      );
    }
    if (method === 'DELETE') {
      appendFileSync(
        process.env.PLAN_EVENT_FILE ?? '',
        `delete-${url.endsWith('/old') ? 'old' : 'replacement'}\n`,
      );
      return Promise.resolve(envelope({ id: 'deleted' }));
    }
    return Promise.resolve(
      envelope(
        [
          { id: 'bootstrap', name: 'standards-broker', status: 'active' },
          expiringToken(target),
        ],
        pageInfo(2),
      ),
    );
  }) as typeof fetch;
};

export const cleanupPlanRun = (): void => {
  mock.restore();
  globalThis.fetch = originalFetch;
  process.env.PATH = originalPath;
  for (const [key, value] of [
    ['STANDARDS_BROKER_FILE', originalBroker],
    ['PLAN_EVENT_FILE', originalEventFile],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  if (root.length > 0) {
    rmSync(root, { recursive: true, force: true });
    root = '';
  }
};
