import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { HTTP_CREATED } from './github-api';
import { runGithubApply } from './github-commands';
import {
  captureConsole,
  cleanup,
  createConsumer,
  declaredPatchBody,
  installApi,
  installNetworkFailure,
  liveRepository,
  liveRulesetSummary,
  OPT_OUT_NOTICE,
} from './github-commands-test-support';
import { restoreProcessEnv } from './process-env-test-support';

const originalFetch = globalThis.fetch;
const originalGhHost = process.env.GH_HOST;
const originalGhToken = process.env.GH_TOKEN;
const originalGithubToken = process.env.GITHUB_TOKEN;
const commandConsole = Reflect.get(globalThis, 'console') as Console;
const temporaryPaths: Array<string> = [];
let output = captureConsole(commandConsole);

beforeEach(() => {
  output.restore();
  output = captureConsole(commandConsole);
  process.env.GH_TOKEN = 'test-token';
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  output.restore();
  cleanup(...temporaryPaths.splice(0));
  globalThis.fetch = originalFetch;
  restoreProcessEnv('GH_HOST', originalGhHost);
  restoreProcessEnv('GH_TOKEN', originalGhToken);
  restoreProcessEnv('GITHUB_TOKEN', originalGithubToken);
});

const consumer = (options?: Parameters<typeof createConsumer>[0]): string => {
  const path = createConsumer(options);
  temporaryPaths.push(path);
  return path;
};

describe('runGithubApply', () => {
  it('applies private repository drift without patching plan-gated settings', async () => {
    const calls = installApi([
      { body: liveRepository(true, false, false) },
      { body: liveRepository(true, false) },
    ]);

    expect(await runGithubApply(consumer())).toBe(true);
    expect(calls).toEqual([
      { method: 'GET', path: '/repos/owner/repo', search: '', body: null },
      {
        method: 'PATCH',
        path: '/repos/owner/repo',
        search: '',
        body: declaredPatchBody(false),
      },
    ]);
    expect(output.logs).toEqual([
      OPT_OUT_NOTICE,
      '  updated repository merge settings',
      'standards github: enforceable settings apply complete for owner/repo; plan-gated settings skipped',
    ]);
  });

  it('reports convergence despite plan-gated auto-merge drift', async () => {
    const calls = installApi([{ body: liveRepository(true, false) }]);

    expect(await runGithubApply(consumer())).toBe(true);
    expect(calls).toHaveLength(1);
    expect(output.logs).toEqual([
      OPT_OUT_NOTICE,
      'standards github: enforceable settings already converged for owner/repo; plan-gated settings skipped',
    ]);
  });

  it('rejects a public opt-out before any mutation or ruleset request', async () => {
    const calls = installApi([{ body: liveRepository(false, false) }]);

    expect(await runGithubApply(consumer())).toBe(false);
    expect(calls).toEqual([
      { method: 'GET', path: '/repos/owner/repo', search: '', body: null },
    ]);
    expect(output.logs).toEqual([OPT_OUT_NOTICE]);
    expect(output.errors).toEqual([
      'standards github: .github/settings.local.json "rulesetEnforcement" may only be declared for a private repository; owner/repo is public',
    ]);
  });

  it('preserves enforced repository and ruleset mutations', async () => {
    const calls = installApi([
      { body: liveRepository(false, false) },
      { body: liveRepository(false, true) },
      { body: [] },
      { status: HTTP_CREATED, body: { id: 7 } },
    ]);

    expect(await runGithubApply(consumer({ optOut: false }))).toBe(true);
    expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/repos/owner/repo' },
      { method: 'PATCH', path: '/repos/owner/repo' },
      { method: 'GET', path: '/repos/owner/repo/rulesets' },
      { method: 'POST', path: '/repos/owner/repo/rulesets' },
    ]);
    expect(output.logs).not.toContain(OPT_OUT_NOTICE);
    expect(output.logs.at(-1)).toBe(
      'standards github: apply complete for owner/repo',
    );
  });

  it('prints the opt-out notice before every early apply failure', async () => {
    expect(await runGithubApply(consumer({ origin: false }))).toBe(false);
    expect(output.logs).toEqual([OPT_OUT_NOTICE]);

    output.logs.length = 0;
    output.errors.length = 0;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    process.env.GH_HOST = 'missing.invalid';
    expect(await runGithubApply(consumer())).toBe(false);
    expect(output.logs).toEqual([OPT_OUT_NOTICE]);
    expect(output.errors.at(-1)).toContain('apply needs an admin token');

    output.logs.length = 0;
    output.errors.length = 0;
    process.env.GH_TOKEN = 'test-token';
    restoreProcessEnv('GH_HOST', originalGhHost);
    installNetworkFailure();
    expect(await runGithubApply(consumer())).toBe(false);
    expect(output.logs).toEqual([OPT_OUT_NOTICE]);
    expect(output.errors).toEqual(['standards github: offline']);
  });
});

describe('runGithubApply update verification', () => {
  it('fails when GitHub returns HTTP 200 but silently keeps an old value', async () => {
    const calls = installApi([
      { body: liveRepository(false, false) },
      { body: liveRepository(false, false) },
    ]);

    expect(await runGithubApply(consumer({ optOut: false }))).toBe(false);
    expect(calls.map(({ method }) => method)).toEqual(['GET', 'PATCH']);
    const errors = output.errors.join('\n');
    expect(errors).toContain(
      'GitHub returned HTTP 200 but ignored part of the update',
    );
    expect(errors).toContain('allow_auto_merge');
    expect(errors).toContain('declare the ruleset-enforcement opt-out');
  });
});

it.each([0, 1])(
  'compares hidden bypass actors before applying (count %s)',
  async (count) => {
    const ruleset = {
      id: 7,
      name: 'Protect main',
      target: 'branch',
      enforcement: 'active',
      rules: [],
    };
    const calls = installApi([
      { body: liveRepository(false, true) },
      { body: [liveRulesetSummary()] },
      { body: ruleset },
      {
        body: JSON.parse(
          `{"data":{"repository":{"rulesets":{"nodes":[{"databaseId":7,"source":{"__typename":"Repository"},"bypassActors":{"totalCount":${count},"nodes":${count === 0 ? '[]' : '[null]'}}}]}}}}`,
        ) as unknown,
      },
      { body: ruleset },
    ]);
    expect(
      await runGithubApply(consumer({ optOut: false, bypassActors: [] })),
    ).toBe(true);
    expect(calls.filter(({ method }) => method === 'PUT')).toHaveLength(count);
    expect(output.errors).toEqual([]);
  },
);

it('fails unreadable ruleset identity without rewriting it', async () => {
  const calls = installApi([
    { body: liveRepository(false, true) },
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
    { body: { errors: [{ message: 'Forbidden' }] } },
  ]);
  expect(
    await runGithubApply(consumer({ optOut: false, bypassActors: [] })),
  ).toBe(false);
  expect(calls.filter(({ method }) => method === 'PUT')).toHaveLength(0);
  expect(output.errors.join(' ')).toContain('cannot verify ruleset fields');
});
