import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { HTTP_OK } from './github-api';
import { runGithubApply } from './github-commands';

const originalFetch = globalThis.fetch;
const originalToken = process.env.GH_TOKEN;
let consumer: string | null = null;

const response = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: HTTP_OK,
  });

const createConsumer = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'github-repository-apply-'));
  consumer = directory;
  mkdirSync(join(directory, '.github'));
  writeFileSync(
    join(directory, '.github/settings.json'),
    '{"environments":[],"repository":{"allow_auto_merge":true},"rulesets":[]}',
  );
  writeFileSync(
    join(directory, '.github/settings.local.json'),
    '{"repository":{},"rulesets":[],"environments":[]}',
  );
  execFileSync('git', ['init', '--quiet', directory]);
  execFileSync('git', [
    '-C',
    directory,
    'remote',
    'add',
    'origin',
    'git@github.com:owner/repo.git',
  ]);
  return directory;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) {
    delete process.env.GH_TOKEN;
  } else {
    process.env.GH_TOKEN = originalToken;
  }
  if (consumer !== null) {
    rmSync(consumer, { force: true, recursive: true });
    consumer = null;
  }
});

describe('repository apply verification', () => {
  it('stops before downstream mutations on unverified 200 responses', async () => {
    const directory = createConsumer();
    const patchedBodies = [
      {},
      JSON.parse('{"allow_auto_merge":false}') as unknown,
      JSON.parse('{"allow_auto_merge":"yes"}') as unknown,
    ];
    for (const patchedBody of patchedBodies) {
      const methods: Array<string> = [];
      globalThis.fetch = Object.assign(
        (input: URL | RequestInfo, init?: RequestInit) => {
          const method = init?.method ?? 'GET';
          methods.push(method);
          const readBody = String(input).includes('/rulesets?')
            ? []
            : (JSON.parse('{"allow_auto_merge":false}') as unknown);
          return Promise.resolve(
            response(method === 'PATCH' ? patchedBody : readBody),
          );
        },
        { preconnect: originalFetch.preconnect },
      );
      process.env.GH_TOKEN = 'token';
      const log = spyOn(console, 'log').mockImplementation(() => undefined);
      const error = spyOn(console, 'error').mockImplementation(() => undefined);

      // biome-ignore lint/performance/noAwaitInLoops: Cases replace global fetch and must run sequentially.
      expect(await runGithubApply(directory)).toBe(false);
      expect(methods.filter((method) => method !== 'GET')).toEqual(['PATCH']);
      expect(log.mock.calls.flat().join(' ')).not.toContain(
        'updated repository merge settings',
      );
      expect(error.mock.calls.flat().join(' ')).toContain(
        'updating repository settings',
      );
      log.mockRestore();
      error.mockRestore();
    }
  });
});
