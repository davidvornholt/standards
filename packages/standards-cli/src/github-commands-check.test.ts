import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { runGithubCheck } from './github-commands';
import {
  captureConsole,
  cleanup,
  createConsumer,
  installApi,
  installNetworkFailure,
  liveRepository,
  liveRulesetSummary,
  OPT_OUT_NOTICE,
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

describe('runGithubCheck', () => {
  it('accepts a private opt-out and ignores plan-gated auto-merge drift', async () => {
    const calls = installApi([{ body: liveRepository(true, false) }]);

    expect(await runGithubCheck(consumer())).toBe(true);
    expect(calls).toEqual([
      { method: 'GET', path: '/repos/owner/repo', body: null },
    ]);
    expect(output.logs).toEqual([
      OPT_OUT_NOTICE,
      'standards github: live repository settings match the declared configuration (plan-gated settings skipped)',
    ]);
    expect(output.errors).toEqual([]);
  });

  it('rejects a public opt-out without requesting rulesets', async () => {
    const calls = installApi([{ body: liveRepository(false, true) }]);

    expect(await runGithubCheck(consumer())).toBe(false);
    expect(calls).toEqual([
      { method: 'GET', path: '/repos/owner/repo', body: null },
    ]);
    expect(output.logs).toEqual([OPT_OUT_NOTICE]);
    expect(output.errors.join('\n')).toContain(
      '"rulesetEnforcement" may only be declared for a private repository; owner/repo is public',
    );
  });

  it('preserves the enforced ruleset request path', async () => {
    const calls = installApi([
      { body: liveRepository(false, true) },
      {
        body: [liveRulesetSummary()],
      },
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

    expect(await runGithubCheck(consumer({ optOut: false }))).toBe(true);
    expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/repos/owner/repo' },
      { method: 'GET', path: '/repos/owner/repo/rulesets' },
      { method: 'GET', path: '/repos/owner/repo/rulesets/7' },
    ]);
    expect(output.logs).toEqual([
      'standards github: live GitHub settings match the declared configuration',
    ]);
  });

  it('checks repository settings, rulesets, and labels in one run', async () => {
    const labels = [
      {
        color: '0e8a16',
        description: 'Approved for automated work',
        name: 'approved-for-fix',
      },
    ];
    const calls = installApi([
      { body: labels },
      { body: liveRepository(false, true) },
      { body: [liveRulesetSummary()] },
      {
        body: {
          enforcement: 'active',
          id: 7,
          name: 'Protect main',
          rules: [],
          target: 'branch',
        },
      },
    ]);

    expect(await runGithubCheck(consumer({ labels, optOut: false }))).toBe(
      true,
    );
    expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/repos/owner/repo/labels' },
      { method: 'GET', path: '/repos/owner/repo' },
      { method: 'GET', path: '/repos/owner/repo/rulesets' },
      { method: 'GET', path: '/repos/owner/repo/rulesets/7' },
    ]);
    expect(output.errors).toEqual([]);
  });

  it('prints the opt-out notice before origin and network failures', async () => {
    expect(await runGithubCheck(consumer({ origin: false }))).toBe(false);
    expect(output.logs).toEqual([OPT_OUT_NOTICE]);

    output.logs.length = 0;
    output.errors.length = 0;
    installNetworkFailure();
    expect(await runGithubCheck(consumer())).toBe(false);
    expect(output.logs).toEqual([OPT_OUT_NOTICE]);
    expect(output.errors.join('\n')).toContain(
      'GitHub API unreachable: offline',
    );
  });
});

describe('runGithubCheck fail-closed visibility', () => {
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
