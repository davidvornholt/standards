import { afterEach, expect, it } from 'bun:test';
import { applyPrefetchedRulesets } from './github-apply';
import type { GithubSettings } from './github-settings-value';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('does not read back an already-converged ruleset set', async () => {
  const requests: Array<string> = [];
  globalThis.fetch = Object.assign(
    (input: URL | RequestInfo) => {
      requests.push(String(input));
      return Promise.resolve(new Response(null, { status: 500 }));
    },
    { preconnect: originalFetch.preconnect },
  );
  const declared: GithubSettings = {
    defaultBranchProtection: null,
    environments: [],
    repository: {},
    rulesets: [],
  };

  expect(
    await applyPrefetchedRulesets({
      declared,
      live: { problem: null, rulesets: [] },
      reportAction: () => undefined,
      repo: 'owner/repo',
      token: 'token',
    }),
  ).toEqual([]);
  expect(requests).toEqual([]);
});
