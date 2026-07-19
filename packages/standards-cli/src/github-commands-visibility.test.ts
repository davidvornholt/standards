import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { HTTP_FORBIDDEN, HTTP_UNAUTHORIZED } from './github-api';
import { runGithubCheck } from './github-commands';
import {
  captureConsole,
  cleanup,
  createConsumer,
  installApi,
  liveRepository,
  liveRulesetSummary,
} from './github-commands-test-support';

const originalFetch = globalThis.fetch;
const originalGhToken = process.env.GH_TOKEN;
const originalGithubToken = process.env.GITHUB_TOKEN;
const commandConsole = Reflect.get(globalThis, 'console') as Console;
const temporaryPaths: Array<string> = [];
let output = captureConsole(commandConsole);

beforeEach(() => {
  output.restore();
  output = captureConsole(commandConsole);
  process.env.GH_TOKEN = 'test-token';
  process.env.GITHUB_TOKEN = undefined;
});

afterEach(() => {
  output.restore();
  cleanup(...temporaryPaths.splice(0));
  globalThis.fetch = originalFetch;
  process.env.GH_TOKEN = originalGhToken;
  process.env.GITHUB_TOKEN = originalGithubToken;
});

const consumer = (options?: Parameters<typeof createConsumer>[0]): string => {
  const path = createConsumer(options);
  temporaryPaths.push(path);
  return path;
};

describe('runGithubCheck fail-closed visibility', () => {
  it.each([
    {
      message: 'Bad credentials',
      status: HTTP_UNAUTHORIZED,
    },
    {
      message: 'Resource not accessible by personal access token',
      status: HTTP_FORBIDDEN,
    },
    {
      message: 'Resource not accessible by integration',
      status: HTTP_FORBIDDEN,
    },
  ])('names the label-read credential fix after $status $message', async ({
    message,
    status,
  }) => {
    const calls = installApi([
      {
        status,
        body: { message },
      },
    ]);

    expect(
      await runGithubCheck(
        consumer({
          labels: [
            {
              color: '0e8a16',
              description: 'Approved for automated work',
              name: 'approved-for-fix',
            },
          ],
          optOut: false,
        }),
      ),
    ).toBe(false);
    expect(calls.map(({ path }) => path)).toEqual(['/repos/owner/repo/labels']);
    const errors = output.errors.join('\n');
    expect(errors).toContain('declared labels not visible to this token');
    expect(errors).toContain('ci.github_settings_read_token');
    expect(errors).toContain('read-only "Issues" access');
    expect(errors).toContain('"Pull requests" read');
    expect(errors).not.toContain('GitHub API unreachable');
  });

  it.each([
    'API rate limit exceeded for test-token',
    'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
  ])('preserves the API cause for a non-permission 403', async (message) => {
    const calls = installApi([
      {
        status: HTTP_FORBIDDEN,
        body: { message },
      },
    ]);

    expect(
      await runGithubCheck(
        consumer({
          labels: [
            {
              color: '0e8a16',
              description: 'Approved for automated work',
              name: 'approved-for-fix',
            },
          ],
          optOut: false,
        }),
      ),
    ).toBe(false);
    expect(calls.map(({ path }) => path)).toEqual(['/repos/owner/repo/labels']);
    const errors = output.errors.join('\n');
    expect(errors).toContain(message);
    expect(errors).not.toContain('declared labels not visible to this token');
    expect(errors).not.toContain('read-only "Issues" access');
  });

  it('fails when repository settings are invisible over REST and GraphQL', async () => {
    installApi([
      { body: JSON.parse('{"private":false}') },
      { body: JSON.parse('{"data":{"repository":null}}') },
      { body: [liveRulesetSummary()] },
      {
        body: {
          id: 7,
          name: 'Protect main',
          target: 'branch',
          enforcement: 'active',
          rules: [],
        },
      },
    ]);

    expect(await runGithubCheck(consumer({ optOut: false }))).toBe(false);
    const errors = output.errors.join('\n');
    expect(errors).toContain(
      'repository setting(s) not visible to this token, so the gate cannot verify: allow_auto_merge; delete_branch_on_merge',
    );
    expect(errors).toContain('ci.github_settings_read_token');
  });

  it('fails when a declared ruleset field is invisible to the token', async () => {
    installApi([
      { body: liveRepository(false, true) },
      { body: [liveRulesetSummary()] },
      { body: { id: 7, name: 'Protect main', target: 'branch', rules: [] } },
    ]);

    expect(await runGithubCheck(consumer({ optOut: false }))).toBe(false);
    expect(output.errors.join('\n')).toContain(
      'ruleset field(s) not visible to this token, so the gate cannot verify: ruleset "Protect main": enforcement',
    );
  });
});
