import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runCredsWatch, WATCH_TOKEN_PREFIX } from './creds-watch';
import { restoreProcessEnv } from './process-env-test-support';

const DAY_MS = 86_400_000;
const ACCOUNT = 'b'.repeat(32);
const OTHER = 'c'.repeat(32);
const ACCOUNT_IN_URL = /accounts\/(?<id>[0-9a-f]{32})\//u;
const SAVED = [
  'GITHUB_REPOSITORY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'STANDARDS_BROKER_FILE',
  `${WATCH_TOKEN_PREFIX}${ACCOUNT}`,
  `${WATCH_TOKEN_PREFIX}${OTHER}`,
] as const;
const saved = new Map(SAVED.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let root = '';
let output: Array<string> = [];

// Cloudflare lists one token per account that expires in ten days; GitHub
// accepts every issue write. Each request is recorded with its bearer token.
const fakeApis = (
  failing: ReadonlySet<string> = new Set(),
): Array<{ readonly url: string; readonly bearer: string }> => {
  const requests: Array<{ readonly url: string; readonly bearer: string }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, bearer: headers.get('authorization') ?? '' });
    if (url.startsWith('https://api.github.com/')) {
      const method = init?.method ?? 'GET';
      // One open issue for a repository with nothing due: closing it would
      // be wrong while an account is unseen.
      const stale = {
        number: 3,
        title: 'old',
        body: '<!-- standards-creds-watch: owner/stale -->',
      };
      return Promise.resolve(
        method === 'GET'
          ? Response.json([stale])
          : Response.json({ number: 9 }, { status: 201 }),
      );
    }
    const account = ACCOUNT_IN_URL.exec(url)?.groups?.id;
    if (account === undefined || failing.has(account)) {
      return Promise.resolve(
        Response.json(
          { success: false, errors: [{ code: 9109, message: 'denied' }] },
          { status: 403 },
        ),
      );
    }
    const result = [
      {
        id: `id-${account}`,
        name: `standards/owner/app-${account.slice(0, 1)}/ci/ci.token`,
        status: 'active',
        // biome-ignore lint/style/useNamingConvention: Cloudflare's token field is snake_case.
        expires_on: new Date(Date.now() + 10 * DAY_MS).toISOString(),
        policies: [],
      },
    ];
    return Promise.resolve(
      Response.json({
        success: true,
        errors: [],
        result,
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
  return requests;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'creds-watch-'));
  for (const key of SAVED) {
    delete process.env[key];
  }
  process.env.STANDARDS_BROKER_FILE = join(root, 'missing-broker.yaml');
  output = [];
  const record = (...args: Array<unknown>): void => {
    output.push(args.join(' '));
  };
  spyOn(console, 'log').mockImplementation(record);
  spyOn(console, 'error').mockImplementation(record);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of saved) {
    restoreProcessEnv(key, value);
  }
  rmSync(root, { recursive: true, force: true });
});

describe('creds watch command', () => {
  it('lists each account with its own read-only token from the environment', async () => {
    process.env[`${WATCH_TOKEN_PREFIX}${ACCOUNT}`] = 'watch-b';
    process.env[`${WATCH_TOKEN_PREFIX}${OTHER}`] = 'watch-c';
    const requests = fakeApis();
    expect(await runCredsWatch(false)).toBe(true);
    expect(
      requests.map(({ url, bearer }) => [url.includes(ACCOUNT), bearer]),
    ).toEqual(
      expect.arrayContaining([
        [true, 'Bearer watch-b'],
        [false, 'Bearer watch-c'],
      ]),
    );
    expect(output).toContain('standards creds: owner/app-b');
    expect(output).toContain('standards creds: owner/app-c');
    expect(output.join('\n')).not.toContain('watch-b');
  });

  it('falls back to the broker store and refuses a malformed account variable', async () => {
    const broker = join(root, 'broker.yaml');
    writeFileSync(
      broker,
      `cloudflare:\n  - account_id: ${ACCOUNT}\n    token: bootstrap\n`,
    );
    process.env.STANDARDS_BROKER_FILE = broker;
    const requests = fakeApis();
    expect(await runCredsWatch(false)).toBe(true);
    expect(requests.map(({ bearer }) => bearer)).toEqual(['Bearer bootstrap']);
    process.env[`${WATCH_TOKEN_PREFIX}NOT-AN-ID`] = 'x';
    try {
      expect(await runCredsWatch(false)).toBe(false);
    } finally {
      delete process.env[`${WATCH_TOKEN_PREFIX}NOT-AN-ID`];
    }
  });

  it('requires a home repository and a GitHub token for --issues', async () => {
    process.env[`${WATCH_TOKEN_PREFIX}${ACCOUNT}`] = 'watch-b';
    fakeApis();
    expect(await runCredsWatch(true)).toBe(false);
    expect(output.at(-1)).toContain('GITHUB_REPOSITORY');
  });

  it('fails, and closes no issue, when an account cannot be listed', async () => {
    process.env[`${WATCH_TOKEN_PREFIX}${ACCOUNT}`] = 'watch-b';
    process.env[`${WATCH_TOKEN_PREFIX}${OTHER}`] = 'watch-c';
    process.env.GITHUB_REPOSITORY = 'davidvornholt/personal-infra';
    process.env.GH_TOKEN = 'gh';
    const requests = fakeApis(new Set([OTHER]));
    expect(await runCredsWatch(true)).toBe(false);
    const github = requests.filter(({ url }) =>
      url.startsWith('https://api.github.com/'),
    );
    expect(github.map(({ url }) => new URL(url).pathname)).toEqual([
      '/repos/davidvornholt/personal-infra/labels',
      '/repos/davidvornholt/personal-infra/issues',
      '/repos/davidvornholt/personal-infra/issues',
    ]);
    expect(output.join('\n')).toContain(`account ${OTHER}`);
  });
});
