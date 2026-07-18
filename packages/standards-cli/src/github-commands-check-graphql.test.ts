// REST omits merge settings for read-only viewers; the check retries the
// invisible keys over GraphQL so a read-only PAT stays sufficient.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { runGithubCheck } from './github-commands';
import {
  captureConsole,
  cleanup,
  createConsumer,
  installApi,
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

const consumer = (): string => {
  const path = createConsumer({ optOut: false });
  temporaryPaths.push(path);
  return path;
};

const restHidden = JSON.parse('{"private":false}') as unknown;
const liveRuleset = {
  id: 7,
  name: 'Protect main',
  target: 'branch',
  enforcement: 'active',
  rules: [],
};

describe('runGithubCheck GraphQL merge-settings fallback', () => {
  it('verifies REST-hidden merge settings over GraphQL', async () => {
    const calls = installApi([
      { body: restHidden },
      {
        body: JSON.parse(
          '{"data":{"repository":{"autoMergeAllowed":true,"deleteBranchOnMerge":true}}}',
        ),
      },
      { body: [liveRulesetSummary()] },
      { body: liveRuleset },
    ]);

    expect(await runGithubCheck(consumer())).toBe(true);
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toContain(
      'POST /graphql',
    );
    expect(output.errors).toEqual([]);
  });

  it('reports drift surfaced by the GraphQL fallback', async () => {
    installApi([
      { body: restHidden },
      {
        body: JSON.parse(
          '{"data":{"repository":{"autoMergeAllowed":false,"deleteBranchOnMerge":true}}}',
        ),
      },
      { body: [liveRulesetSummary()] },
      { body: liveRuleset },
    ]);

    expect(await runGithubCheck(consumer())).toBe(false);
    expect(output.errors.join('\n')).toContain(
      'repository setting "allow_auto_merge" is false on GitHub, declared true',
    );
  });
});
