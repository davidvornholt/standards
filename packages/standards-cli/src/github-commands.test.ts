import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runGithubApply } from './github-commands';

const originalFetch = globalThis.fetch;
const originalToken = process.env.GH_TOKEN;
const directories: Array<string> = [];
const MAX_ENVIRONMENT_NAME_LENGTH = 255;
const MAX_WAIT_TIMER = 43_200;
const MAX_REVIEWERS = 6;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) {
    delete process.env.GH_TOKEN;
  } else {
    process.env.GH_TOKEN = originalToken;
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('runGithubApply', () => {
  it('makes no API request when environment bounds are invalid', async () => {
    const consumer = mkdtempSync(join(tmpdir(), 'github-apply-'));
    directories.push(consumer);
    mkdirSync(join(consumer, '.github'));
    const invalidEnvironment = JSON.parse(
      `{"name":"${'e'.repeat(MAX_ENVIRONMENT_NAME_LENGTH + 1)}","wait_timer":${MAX_WAIT_TIMER + 1},"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false},"deployment_branch_policies":[]}`,
    ) as Record<string, unknown>;
    invalidEnvironment.reviewers = Array.from(
      { length: MAX_REVIEWERS + 1 },
      (_, index) => ({ type: 'User', id: index + 1 }),
    );
    writeFileSync(
      join(consumer, '.github/settings.json'),
      JSON.stringify({ environments: [invalidEnvironment] }),
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
    let requests = 0;
    globalThis.fetch = Object.assign(
      () => {
        requests += 1;
        return Promise.resolve(new Response(null, { status: 500 }));
      },
      { preconnect: originalFetch.preconnect },
    );
    process.env.GH_TOKEN = 'test-token';

    expect(await runGithubApply(consumer)).toBe(false);
    expect(requests).toBe(0);
  });

  it('makes no API request when a declared reviewer identity is invalid', async () => {
    const consumer = mkdtempSync(join(tmpdir(), 'github-apply-'));
    directories.push(consumer);
    mkdirSync(join(consumer, '.github'));
    const canonical = JSON.parse(
      readFileSync(
        join(import.meta.dir, '../../../.github/settings.json'),
        'utf8',
      ),
    ) as { environments: Array<Record<string, unknown>> };
    const [environment] = canonical.environments;
    if (environment !== undefined) {
      environment.reviewers = [{ type: 'User', id: 0 }];
    }
    writeFileSync(
      join(consumer, '.github/settings.json'),
      JSON.stringify(canonical),
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
    let requests = 0;
    globalThis.fetch = Object.assign(
      () => {
        requests += 1;
        return Promise.resolve(new Response(null, { status: 500 }));
      },
      { preconnect: originalFetch.preconnect },
    );
    process.env.GH_TOKEN = 'test-token';

    expect(await runGithubApply(consumer)).toBe(false);
    expect(requests).toBe(0);
  });
});
