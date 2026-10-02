// End-to-end coverage for the ruleset bypass-actor fallback. REST omits
// `bypass_actors` for anything short of an administrator and for a GitHub App
// installation token, so the check retries hidden lists as GraphQL counts: a
// brokered token stays sufficient as far as the *count* goes, while a declared
// non-empty list still fails because GraphQL withholds the identities.
//
// Every test pins the exact request sequence, not just the outcome: the fetch
// stub answers by call order, so a regression that fired the bypass query
// early, twice, or with the merge-settings selection would consume the queue
// differently and still report the same boolean.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { HTTP_UNAUTHORIZED } from './github-api';
import { runGithubApply, runGithubCheck } from './github-commands';
import {
  type ApiCall,
  captureConsole,
  cleanup,
  createConsumer,
  graphqlQuery,
  installApi,
  liveRepository,
  liveRulesetConditions,
  liveRulesetSummary,
} from './github-commands-test-support';
import { BYPASS_ACTORS_KEY } from './github-settings-parse';
import { restoreProcessEnv } from './process-env-test-support';

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
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  output.restore();
  cleanup(...temporaryPaths.splice(0));
  globalThis.fetch = originalFetch;
  restoreProcessEnv('GH_TOKEN', originalGhToken);
  restoreProcessEnv('GITHUB_TOKEN', originalGithubToken);
});

const RULESET_ID = 7;
const OTHER_RULESET_ID = 8;

const consumer = (
  bypassActors: ReadonlyArray<Readonly<Record<string, unknown>>>,
): string => {
  const path = createConsumer({ bypassActors, optOut: false });
  temporaryPaths.push(path);
  return path;
};

const liveRuleset = {
  id: RULESET_ID,
  name: 'Protect main',
  target: 'branch',
  enforcement: 'active',
  conditions: liveRulesetConditions,
  rules: [],
};

// One bypass query, fired last: the repository read, the paginated ruleset
// list, the ruleset detail, then the GraphQL retry for the field REST withheld.
const EXPECTED_SEQUENCE = [
  'GET /repos/owner/repo',
  'GET /repos/owner/repo/rulesets',
  `GET /repos/owner/repo/rulesets/${String(RULESET_ID)}`,
  'POST /graphql',
];

const sequence = (calls: ReadonlyArray<ApiCall>): ReadonlyArray<string> =>
  calls.map(({ method, path }) => `${method} ${path}`);

const installCalls = (graphql: {
  readonly body: unknown;
  readonly status?: number;
}): ReadonlyArray<ApiCall> =>
  installApi([
    { body: liveRepository(false, true) },
    { body: [liveRulesetSummary()] },
    { body: liveRuleset },
    graphql,
  ]);

// `bypassActors(first: 1)` cross-checks the count against its own node list,
// and the count is joined to the REST ruleset by `databaseId`. The actor node
// is null because GraphQL withholds the identities from exactly the tokens this
// fallback exists for.
const countedNode = (
  total: number,
  id = RULESET_ID,
  typename = 'Repository',
): string =>
  `{"databaseId":${String(id)},"source":{"__typename":"${typename}"},"bypassActors":{"totalCount":${String(total)},"nodes":${total === 0 ? '[]' : '[null]'}}}`;

const FORBIDDEN_ERRORS =
  ',"errors":[{"type":"FORBIDDEN","message":"Resource not accessible by integration"}]';

const graphqlBody = (nodes: string, errors = ''): unknown =>
  JSON.parse(
    `{"data":{"repository":{"rulesets":{"nodes":[${nodes}]}}}${errors}}`,
  ) as unknown;

const declaredActor = JSON.parse(
  '{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}',
) as Readonly<Record<string, unknown>>;

const HIDDEN_LIST_PROBLEM =
  'ruleset field(s) not visible to this token, so the gate cannot verify: ruleset "Protect main": bypass_actors';

it.each([
  ['check', runGithubCheck],
  ['apply', runGithubApply],
] as const)(
  'rejects a local omitted bypass list before %s contacts GitHub',
  async (_command, run) => {
    const path = consumer([]);
    const canonicalPath = join(path, '.github/settings.json');
    const canonical = JSON.parse(readFileSync(canonicalPath, 'utf8')) as {
      readonly rulesets: ReadonlyArray<Readonly<Record<string, unknown>>>;
    };
    const localRulesets = canonical.rulesets.map((ruleset) =>
      Object.fromEntries(
        Object.entries(ruleset).filter(([key]) => key !== BYPASS_ACTORS_KEY),
      ),
    );
    writeFileSync(
      canonicalPath,
      JSON.stringify({ ...canonical, rulesets: [] }),
    );
    writeFileSync(
      join(path, '.github/settings.local.json'),
      JSON.stringify({ repository: {}, rulesets: localRulesets }),
    );
    const calls = installApi([
      { body: liveRepository(false, true) },
      { body: [liveRulesetSummary()] },
      { body: { ...liveRuleset, [BYPASS_ACTORS_KEY]: [declaredActor] } },
    ]);
    expect(await run(path)).toBe(false);
    expect(calls).toEqual([]);
    expect(output.errors.join('\n')).toContain(
      '.github/settings.local.json ruleset "Protect main" must declare "bypass_actors"; use [] if nobody may bypass',
    );
  },
);

describe('runGithubCheck GraphQL bypass-actor fallback', () => {
  it('verifies a declared-empty bypass list from the GraphQL count', async () => {
    const calls = installCalls({ body: graphqlBody(countedNode(0)) });

    expect(await runGithubCheck(consumer([]))).toBe(true);
    expect(sequence(calls)).toEqual(EXPECTED_SEQUENCE);
    expect(output.errors).toEqual([]);
    const query = graphqlQuery(calls.at(-1));
    // Org-inherited rulesets are outside this declaration's authority, so the
    // count must come from the repository's own rulesets alone. The
    // merge-settings fallback has its own selection; reusing it here would
    // silently ask for something else.
    expect(query).toContain('includeParents: false');
    expect(query).toContain('bypassActors');
    expect(query).not.toContain('autoMergeAllowed');
  });

  it('reports an undeclared bypass actor as drift, not as a visibility gap', async () => {
    const calls = installCalls({ body: graphqlBody(countedNode(1)) });

    expect(await runGithubCheck(consumer([]))).toBe(false);
    expect(sequence(calls)).toEqual(EXPECTED_SEQUENCE);
    expect(output.errors.join('\n')).toContain(
      'ruleset "Protect main": bypass_actors differs from the declared configuration (GitHub reports 1 bypass actor(s); 0 declared)',
    );
    expect(output.errors.join('\n')).not.toContain('not visible to this token');
  });

  it('fails closed when a declared non-empty list matches only in count', async () => {
    const calls = installCalls({ body: graphqlBody(countedNode(1)) });

    expect(await runGithubCheck(consumer([declaredActor]))).toBe(false);
    expect(sequence(calls)).toEqual(EXPECTED_SEQUENCE);
    expect(output.errors.join('\n')).toContain(HIDDEN_LIST_PROBLEM);
    expect(output.errors.join('\n')).toContain('withholds their identities');
  });

  it('fails closed when GraphQL answers nothing', async () => {
    const calls = installCalls({
      body: JSON.parse('{"message":"Bad credentials"}'),
      status: HTTP_UNAUTHORIZED,
    });

    expect(await runGithubCheck(consumer([]))).toBe(false);
    expect(sequence(calls)).toEqual(EXPECTED_SEQUENCE);
    expect(output.errors.join('\n')).toContain(HIDDEN_LIST_PROBLEM);
    expect(output.errors.join('\n')).toContain('HTTP 401 Bad credentials');
  });
});

// A 200 carrying no usable answer *for this ruleset* is the realistic shape:
// the ruleset was renamed or paged out of the answered set, the only node
// bearing its id is org-owned, or the count itself was suppressed.
describe('runGithubCheck when GraphQL answers 200 but not for this ruleset', () => {
  it.each([
    [
      'the answered page holds another ruleset',
      graphqlBody(countedNode(0, OTHER_RULESET_ID)),
      'Neither REST nor the GraphQL bypass-actor count answered for the ruleset(s) listed',
    ],
    [
      'the node carrying its id is org-owned',
      graphqlBody(countedNode(0, RULESET_ID, 'Organization')),
      'Neither REST nor the GraphQL bypass-actor count answered for the ruleset(s) listed',
    ],
    // The highest-severity shape in the whole fallback: HTTP 200, a `data` that
    // looks like a verified empty list, and an errors array saying the field
    // was denied. Reading that `0` would print nothing and exit 0 on a
    // repository that grants a live bypass.
    [
      'the count was suppressed beside a FORBIDDEN error',
      graphqlBody(countedNode(0), FORBIDDEN_ERRORS),
      'Resource not accessible by integration',
    ],
  ])('fails closed when %s', async (_case, body, advice) => {
    const calls = installCalls({ body });

    expect(await runGithubCheck(consumer([]))).toBe(false);
    expect(sequence(calls)).toEqual(EXPECTED_SEQUENCE);
    expect(output.errors.join('\n')).toContain(HIDDEN_LIST_PROBLEM);
    expect(output.errors.join('\n')).toContain(advice);
  });
});
