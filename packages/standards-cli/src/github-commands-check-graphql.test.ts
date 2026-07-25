// REST omits merge settings for read-only viewers and ruleset bypass actors
// for anything short of an administrator; the check retries both over GraphQL
// so a read-only PAT stays sufficient, and a brokered installation token stays
// sufficient as far as the bypass-actor *count* goes — a declared non-empty
// list still fails closed, because GraphQL withholds the identities that would
// verify it.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
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

const consumer = (
  bypassActors?: ReadonlyArray<Readonly<Record<string, unknown>>>,
): string => {
  const path = createConsumer({ bypassActors, optOut: false });
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
          '{"data":{"repository":{"autoMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false,"squashMergeAllowed":true,"deleteBranchOnMerge":true}}}',
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
          '{"data":{"repository":{"autoMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":false,"squashMergeAllowed":true,"deleteBranchOnMerge":true}}}',
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

// REST answers a ruleset without its `bypass_actors` key for any viewer short
// of an administrator, and for a GitHub App installation token at every
// permission level.
// `bypassActors(first: 1)` cross-checks the count against its own node list,
// and the count is joined to the REST ruleset by `databaseId`. The nodes are
// null because GraphQL withholds the identities from exactly the tokens this
// fallback exists for.
const bypassCounts = (totalCount: number): unknown =>
  JSON.parse(
    `{"data":{"repository":{"rulesets":{"nodes":[{"databaseId":7,"source":{"__typename":"Repository"},"bypassActors":{"totalCount":${String(totalCount)},"nodes":${totalCount === 0 ? '[]' : '[null]'}}}]}}}}`,
  ) as unknown;

const declaredActor = JSON.parse(
  '{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}',
) as Readonly<Record<string, unknown>>;

describe('runGithubCheck GraphQL bypass-actor fallback', () => {
  it('verifies a declared-empty bypass list from the GraphQL count', async () => {
    const calls = installApi([
      { body: liveRepository(false, true) },
      { body: [liveRulesetSummary()] },
      { body: liveRuleset },
      { body: bypassCounts(0) },
    ]);

    expect(await runGithubCheck(consumer([]))).toBe(true);
    expect(output.errors).toEqual([]);
    const query = String(
      (calls.at(-1)?.body as { readonly query: unknown }).query,
    );
    // Org-inherited rulesets are outside this declaration's authority, so the
    // count must come from the repository's own rulesets alone.
    expect(query).toContain('includeParents: false');
    expect(query).toContain('bypassActors');
  });

  it('reports an undeclared bypass actor as drift, not as a visibility gap', async () => {
    installApi([
      { body: liveRepository(false, true) },
      { body: [liveRulesetSummary()] },
      { body: liveRuleset },
      { body: bypassCounts(1) },
    ]);

    expect(await runGithubCheck(consumer([]))).toBe(false);
    expect(output.errors.join('\n')).toContain(
      'ruleset "Protect main": bypass_actors differs from the declared configuration',
    );
    expect(output.errors.join('\n')).not.toContain('not visible to this token');
  });

  it('fails closed when a declared non-empty list matches only in count', async () => {
    installApi([
      { body: liveRepository(false, true) },
      { body: [liveRulesetSummary()] },
      { body: liveRuleset },
      { body: bypassCounts(1) },
    ]);

    expect(await runGithubCheck(consumer([declaredActor]))).toBe(false);
    expect(output.errors.join('\n')).toContain(
      'ruleset field(s) not visible to this token, so the gate cannot verify: ruleset "Protect main": bypass_actors',
    );
  });

  it('fails closed when GraphQL answers nothing', async () => {
    installApi([
      { body: liveRepository(false, true) },
      { body: [liveRulesetSummary()] },
      { body: liveRuleset },
      { status: 401, body: JSON.parse('{"message":"Bad credentials"}') },
    ]);

    expect(await runGithubCheck(consumer([]))).toBe(false);
    expect(output.errors.join('\n')).toContain(
      'ruleset field(s) not visible to this token, so the gate cannot verify: ruleset "Protect main": bypass_actors',
    );
  });
});
