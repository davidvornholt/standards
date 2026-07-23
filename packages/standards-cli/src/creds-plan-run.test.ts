import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
const ENCRYPTED_SECRETS =
  'ci:\n  token: ENC[AES256_GCM,data:x]\nsops:\n  mac: ENC[AES256_GCM,data:y]\n';
const originalBroker = process.env.STANDARDS_BROKER_FILE;
const originalEventFile = process.env.PLAN_EVENT_FILE;
const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
let root = '';

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
const initialize = (secrets: string): { consumer: string; events: string } => {
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

const installSops = (body: string): void => {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const path = join(bin, 'sops');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, EXECUTABLE_MODE);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
};

const expiringToken = (target = 'ci'): unknown => {
  const expires = Date.now() + 10 * DAY_MS;
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

const stubCloudflare = (target = 'ci'): void => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
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
    return Promise.resolve(envelope([expiringToken(target)], pageInfo(1)));
  }) as typeof fetch;
};

afterEach(() => {
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
  }
});

describe('creds plan/apply safety', () => {
  it.each([
    ['malformed YAML', 'ci: [\n'],
    ['missing SOPS metadata', 'ci:\n  token: plaintext\n'],
  ])('aborts on %s without provider mutation', async (_, secrets) => {
    const { consumer, events } = initialize(secrets);
    stubCloudflare();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsPlan(consumer, true)).toBe(false);
    expect(readFileSync(events, 'utf8')).toBe('');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('reconciliation aborted'),
    );
  });
  it.each([
    ['flat', 'ci', 'secrets/ci.yaml'],
    ['host', 'prod', 'infra/hosts/prod/secrets.yaml'],
  ] as const)('aborts on an unsafe %s target without provider deletion', async (kind, target, rel) => {
    const { consumer, events } = initialize(ENCRYPTED_SECRETS);
    const outside = join(root, `outside-${kind}`);
    if (kind === 'flat') {
      writeFileSync(outside, 'outside\n');
      rmSync(join(consumer, rel));
      symlinkSync(outside, join(consumer, rel));
    } else {
      mkdirSync(outside);
      mkdirSync(join(consumer, 'infra', 'hosts'), { recursive: true });
      symlinkSync(outside, join(consumer, 'infra', 'hosts', target), 'dir');
    }
    stubCloudflare(target);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsPlan(consumer, true)).toBe(false);
    expect(readFileSync(events, 'utf8')).toBe('');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`unsafe encrypted secrets target ${rel}`),
    );
  });
  it('cleans a replacement and preserves the old token on write failure', async () => {
    const { consumer, events } = initialize(ENCRYPTED_SECRETS);
    installSops(
      'if [ "$1" = "decrypt" ]; then printf \'"old-value"\'; exit 0; fi\nexit 1',
    );
    stubCloudflare();
    expect(await runCredsPlan(consumer, true)).toBe(false);
    expect(readFileSync(events, 'utf8').trim().split('\n')).toEqual([
      'create',
      'delete-replacement',
    ]);
  });
  it('writes and verifies the replacement before revoking the old token', async () => {
    const { consumer, events } = initialize(ENCRYPTED_SECRETS);
    installSops(
      'if [ "$1" = "decrypt" ]; then printf \'"new-value"\'; exit 0; fi\neval "$SOPS_EDITOR \\"$2\\"" && printf "write\\n" >> "$PLAN_EVENT_FILE"',
    );
    stubCloudflare();
    expect(await runCredsPlan(consumer, true)).toBe(true);
    expect(readFileSync(events, 'utf8').trim().split('\n')).toEqual([
      'create',
      'write',
      'delete-old',
    ]);
  });
});
