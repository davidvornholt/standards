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
  OPT_OUT_NOTICE,
} from './github-commands-test-support';

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
  process.env.GITHUB_TOKEN = undefined;
});

afterEach(() => {
  output.restore();
  cleanup(...temporaryPaths.splice(0));
  globalThis.fetch = originalFetch;
  process.env.GH_HOST = originalGhHost;
  process.env.GH_TOKEN = originalGhToken;
  process.env.GITHUB_TOKEN = originalGithubToken;
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
      { method: 'GET', path: '/repos/owner/repo', body: null },
      {
        method: 'PATCH',
        path: '/repos/owner/repo',
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
      { method: 'GET', path: '/repos/owner/repo', body: null },
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
    process.env.GH_TOKEN = undefined;
    process.env.GITHUB_TOKEN = undefined;
    process.env.GH_HOST = 'missing.invalid';
    expect(await runGithubApply(consumer())).toBe(false);
    expect(output.logs).toEqual([OPT_OUT_NOTICE]);
    expect(output.errors.at(-1)).toContain('apply needs an admin token');

    output.logs.length = 0;
    output.errors.length = 0;
    process.env.GH_TOKEN = 'test-token';
    process.env.GH_HOST = originalGhHost;
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
