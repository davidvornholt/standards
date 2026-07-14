import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGithubApply } from './github-commands';

const originalFetch = globalThis.fetch;
const directories: Array<string> = [];

const createConsumer = (environment: unknown): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'github-environment-schema-'));
  directories.push(consumer);
  mkdirSync(join(consumer, '.github'));
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
  return consumer;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('protected-branch-only environment declarations', () => {
  it('rejects custom mode and deployment policies before API requests', async () => {
    const customMode = JSON.parse(
      '{"name":"production","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}',
    ) as unknown;
    const customPolicies = JSON.parse(
      '{"name":"production","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false},"deployment_branch_policies":[]}',
    ) as unknown;
    let requests = 0;
    globalThis.fetch = Object.assign(
      () => {
        requests += 1;
        return Promise.resolve(new Response(null, { status: 200 }));
      },
      { preconnect: originalFetch.preconnect },
    );
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    const results = await Promise.all(
      [customMode, customPolicies].map((environment) =>
        runGithubApply(createConsumer(environment)),
      ),
    );

    expect(results).toEqual([false, false]);
    expect(requests).toBe(0);
    expect(error.mock.calls.flat().join(' ')).toContain(
      'must enable protected branches only',
    );
    expect(error.mock.calls.flat().join(' ')).toContain(
      'has unknown key "deployment_branch_policies"',
    );
    error.mockRestore();
  });
});
