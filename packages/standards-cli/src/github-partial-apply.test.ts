import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { HTTP_CREATED, HTTP_OK } from './github-api';
import { runGithubApply } from './github-commands';
import { declaredRuleset } from './github-ruleset-test-fixture';

const originalFetch = globalThis.fetch;
const originalToken = process.env.GH_TOKEN;
const directories: Array<string> = [];
const HTTP_ERROR = 500;

const response = (status: number, body: unknown = null): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });

const createConsumer = (
  settings: Readonly<Record<string, unknown>>,
): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'github-partial-apply-'));
  directories.push(consumer);
  mkdirSync(join(consumer, '.github'));
  writeFileSync(
    join(consumer, '.github/settings.json'),
    JSON.stringify(settings),
  );
  writeFileSync(
    join(consumer, '.github/settings.local.json'),
    '{"repository":{},"rulesets":[],"environments":[]}',
  );
  execFileSync('git', ['init', '--quiet', consumer]);
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

const environment = JSON.parse(
  '{"name":"production","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}',
) as Record<string, unknown>;
const environmentFailureRead = (url: string): Response => {
  if (url.includes('/rulesets?')) {
    return response(HTTP_OK, []);
  }
  if (url.includes('deployment_protection_rules')) {
    return response(
      HTTP_OK,
      JSON.parse(
        '{"total_count":0,"custom_deployment_protection_rules":[]}',
      ) as unknown,
    );
  }
  if (url.includes('/environments/production')) {
    return response(
      HTTP_OK,
      JSON.parse(
        '{"name":"production","protection_rules":[{"id":1,"type":"branch_policy"},{"type":"wait_timer","wait_timer":5}],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}',
      ) as unknown,
    );
  }
  return response(HTTP_OK, JSON.parse('{"allow_auto_merge":false}') as unknown);
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

describe('partial GitHub apply reporting', () => {
  it('reports a repository update before a later environment PUT failure', async () => {
    const consumer = createConsumer(
      JSON.parse(
        `{"environments":[${JSON.stringify(environment)}],"repository":{"allow_auto_merge":true},"rulesets":[]}`,
      ) as Record<string, unknown>,
    );
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (method === 'PATCH') {
          return Promise.resolve(
            response(
              HTTP_OK,
              JSON.parse('{"allow_auto_merge":true}') as unknown,
            ),
          );
        }
        if (method === 'PUT') {
          return Promise.resolve(
            response(HTTP_ERROR, { message: 'put failed' }),
          );
        }
        return Promise.resolve(environmentFailureRead(url));
      },
      { preconnect: originalFetch.preconnect },
    );
    process.env.GH_TOKEN = 'token';
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runGithubApply(consumer)).toBe(false);
    expect(log.mock.calls.flat().join(' ')).toContain(
      'updated repository merge settings',
    );
    expect(error.mock.calls.flat().join(' ')).toContain(
      'updating environment "production"',
    );
    log.mockRestore();
    error.mockRestore();
  });

  it('reports a created ruleset before a later ruleset failure', async () => {
    const consumer = createConsumer({
      environments: [],
      repository: {},
      rulesets: [declaredRuleset('First'), declaredRuleset('Second')],
    });
    let creations = 0;
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if ((init?.method ?? 'GET') === 'POST') {
          creations += 1;
          return Promise.resolve(
            creations === 1
              ? response(HTTP_CREATED, {})
              : response(HTTP_ERROR, { message: 'create failed' }),
          );
        }
        return Promise.resolve(
          url.includes('/rulesets?')
            ? response(HTTP_OK, [])
            : response(HTTP_OK, {}),
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    process.env.GH_TOKEN = 'token';
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runGithubApply(consumer)).toBe(false);
    expect(log.mock.calls.flat().join(' ')).toContain(
      'created ruleset "First"',
    );
    expect(error.mock.calls.flat().join(' ')).toContain(
      'creating ruleset "Second"',
    );
    log.mockRestore();
    error.mockRestore();
  });
});
