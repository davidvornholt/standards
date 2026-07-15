import { afterEach, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { HTTP_OK } from './github-api';
import { runGithubApply } from './github-commands';

const originalFetch = globalThis.fetch;
const originalToken = process.env.GH_TOKEN;
const directories: Array<string> = [];
const ALLOW_AUTO_MERGE = 'allow_auto_merge';

const response = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: HTTP_OK,
  });

const createConsumer = (): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'github-origin-apply-'));
  directories.push(consumer);
  mkdirSync(join(consumer, '.github'));
  writeFileSync(
    join(consumer, '.github/settings.json'),
    '{"environments":[],"repository":{"allow_auto_merge":true},"rulesets":[]}',
  );
  writeFileSync(
    join(consumer, '.github/settings.local.json'),
    '{"repository":{},"rulesets":[],"environments":[]}',
  );
  execFileSync('git', ['-C', consumer, 'init', '--quiet', '-b', 'main']);
  execFileSync('git', [
    '-C',
    consumer,
    'remote',
    'add',
    'origin',
    'git@github.com:owner/repo.git',
  ]);
  return consumer;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) {
    delete process.env.GH_TOKEN;
  } else {
    process.env.GH_TOKEN = originalToken;
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

it('rejects a changed local origin immediately before repository mutation', async () => {
  const consumer = createConsumer();
  const methods: Array<string> = [];
  let changed = false;
  globalThis.fetch = Object.assign(
    (input: URL | RequestInfo, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (!changed) {
        changed = true;
        execFileSync('git', [
          '-C',
          consumer,
          'remote',
          'set-url',
          'origin',
          'git@github.com:owner/changed.git',
        ]);
      }
      return Promise.resolve(
        response(
          String(input).includes('/rulesets?')
            ? []
            : { [ALLOW_AUTO_MERGE]: false },
        ),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  process.env.GH_TOKEN = 'token';
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  const error = spyOn(console, 'error').mockImplementation(() => undefined);

  expect(await runGithubApply(consumer)).toBe(false);
  expect(methods).not.toContain('PATCH');
  expect(methods).not.toContain('POST');
  expect(methods).not.toContain('PUT');
  expect(methods).not.toContain('DELETE');
  expect(error.mock.calls.flat().join(' ')).toContain(
    'GitHub repository origin changed during apply',
  );
  log.mockRestore();
  error.mockRestore();
});
