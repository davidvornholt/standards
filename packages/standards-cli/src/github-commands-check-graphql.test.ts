// REST omits repository merge settings for read-only viewers, so the check
// retries the invisible keys over GraphQL and a read-only PAT stays sufficient.
// The ruleset bypass-actor fallback that shares the same query helper is
// covered in github-commands-check-bypass.test.ts.
//
// The fetch stub answers by call order, so these tests pin the exact request
// sequence: the GraphQL retry belongs between the repository read and the
// ruleset reads, and must happen exactly once.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { runGithubCheck } from './github-commands';
import {
  type ApiCall,
  captureConsole,
  cleanup,
  createConsumer,
  graphqlQuery,
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

const consumer = (
  bypassActors?: ReadonlyArray<Readonly<Record<string, unknown>>>,
): string => {
  const path = createConsumer({ bypassActors, optOut: false });
  temporaryPaths.push(path);
  return path;
};

const RULESET_ID = 7;

const restHidden = JSON.parse('{"private":false}') as unknown;
const liveRuleset = {
  id: RULESET_ID,
  name: 'Protect main',
  target: 'branch',
  enforcement: 'active',
  rules: [],
};

// The merge-settings retry is the second request and happens once: the
// repository read, the GraphQL retry for the keys REST hid, then the ruleset
// reads. Nothing declares a bypass list here, so no ruleset query follows.
const EXPECTED_SEQUENCE = [
  'GET /repos/owner/repo',
  'POST /graphql',
  'GET /repos/owner/repo/rulesets',
  `GET /repos/owner/repo/rulesets/${String(RULESET_ID)}`,
];

const sequence = (calls: ReadonlyArray<ApiCall>): ReadonlyArray<string> =>
  calls.map(({ method, path }) => `${method} ${path}`);

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
    expect(sequence(calls)).toEqual(EXPECTED_SEQUENCE);
    const query = graphqlQuery(calls[1]);
    expect(query).toContain('autoMergeAllowed');
    // The bypass-actor fallback has its own selection; asking for rulesets here
    // would spend the one retry on the wrong question.
    expect(query).not.toContain('bypassActors');
    expect(output.errors).toEqual([]);
  });

  it('reports drift surfaced by the GraphQL fallback', async () => {
    const calls = installApi([
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
    expect(sequence(calls)).toEqual(EXPECTED_SEQUENCE);
    expect(output.errors.join('\n')).toContain(
      'repository setting "allow_auto_merge" is false on GitHub, declared true',
    );
  });
});
