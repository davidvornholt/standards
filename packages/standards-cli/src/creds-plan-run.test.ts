import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runCredsPlan } from './creds-plan-run';
import {
  ACCOUNT,
  cleanupPlanRun,
  ENCRYPTED_SECRETS,
  initialize,
  installSops,
  planRunRoot,
  stubCloudflare,
} from './creds-plan-run-test-support';

afterEach(cleanupPlanRun);

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
    const outside = join(planRunRoot(), `outside-${kind}`);
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
});

describe('creds plan duplicate account safety', () => {
  it('rejects duplicate account entries before provider access', async () => {
    const { consumer, broker } = initialize(ENCRYPTED_SECRETS);
    writeFileSync(
      broker,
      `cloudflare:\n  - account_id: ${ACCOUNT}\n    token: token-a\n  - account_id: ${ACCOUNT}\n    token: token-b\n`,
    );
    const requests: Array<string> = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${url}`);
      const authorization = new Headers(init?.headers).get('authorization');
      if (url.endsWith('/verify')) {
        return Promise.resolve(
          Response.json({
            success: true,
            errors: [],
            result: {
              id: authorization === 'Bearer token-a' ? 'boot-a' : 'boot-b',
              status: 'active',
            },
          }),
        );
      }
      if (method === 'DELETE') {
        return Promise.resolve(
          Response.json({ success: true, errors: [], result: {} }),
        );
      }
      const tokens = [
        { id: 'boot-a', name: 'standards-broker', status: 'active' },
        {
          id: 'boot-b',
          name: 'standards/davidvornholt/example/ci/root',
          status: 'active',
        },
      ];
      return Promise.resolve(
        Response.json({
          success: true,
          errors: [],
          result: tokens,
          // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
          result_info: {
            page: 1,
            // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
            per_page: 50,
            count: tokens.length,
            // biome-ignore lint/style/useNamingConvention: Cloudflare's response field is snake_case.
            total_count: tokens.length,
          },
        }),
      );
    }) as typeof fetch;

    const outcome = await runCredsPlan(consumer, true).then(
      (value) => ({ value }),
      (error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    expect(requests).toEqual([]);
    expect(outcome).toEqual({
      error: expect.stringContaining('duplicate Cloudflare account'),
    });
  });
});

describe('creds plan/apply mutation safety', () => {
  it('aborts without mutation when bootstrap identity cannot be established', async () => {
    const { consumer, events } = initialize(ENCRYPTED_SECRETS);
    stubCloudflare('ci', null);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsPlan(consumer, true)).toBe(false);
    expect(readFileSync(events, 'utf8')).toBe('');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('valid token ID'),
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
