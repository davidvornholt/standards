import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGithubCheck } from './github-commands';

const originalFetch = globalThis.fetch;
const directories: Array<string> = [];

const response = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('custom deployment protection check', () => {
  it('reports every enabled custom gate as undeclared drift', async () => {
    const consumer = mkdtempSync(join(tmpdir(), 'github-custom-check-'));
    directories.push(consumer);
    mkdirSync(join(consumer, '.github'));
    const environment = JSON.parse(
      '{"name":"production","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}',
    ) as Record<string, unknown>;
    writeFileSync(
      join(consumer, '.github/settings.json'),
      JSON.stringify({ environments: [environment] }),
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
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes('/rulesets?')) {
          return Promise.resolve(response([]));
        }
        if (url.includes('deployment_protection_rules')) {
          return Promise.resolve(
            response(
              JSON.parse(
                '{"total_count":1,"custom_deployment_protection_rules":[{"app":{"id":9,"slug":"external-gate"},"enabled":true,"id":8}]}',
              ) as unknown,
            ),
          );
        }
        if (url.includes('/environments/production')) {
          return Promise.resolve(
            response(
              JSON.parse(
                '{"name":"production","protection_rules":[{"id":1,"type":"branch_policy"}],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}',
              ) as unknown,
            ),
          );
        }
        return Promise.resolve(response({}));
      },
      { preconnect: originalFetch.preconnect },
    );
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runGithubCheck(consumer)).toBe(false);
    expect(error.mock.calls.flat().join(' ')).toContain(
      'custom_deployment_protection_rules differs',
    );
    error.mockRestore();
  });
});
