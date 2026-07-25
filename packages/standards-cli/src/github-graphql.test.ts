// Response-shape coverage for the GraphQL bypass-actor count. Every shape that
// is not a value GitHub actually verified must leave the ruleset uncounted: a
// `0` recovered from a filtered or partially denied connection would pin a live
// bypass list to empty and silently retire the only automated detector for
// weakened branch protection.

import { afterEach, describe, expect, it } from 'bun:test';
import { HTTP_UNAUTHORIZED } from './github-api';
import { graphqlQuery, installApi } from './github-commands-test-support';
import { fetchBypassActorCountsViaGraphql } from './github-graphql';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const RULESET_ID = 7;
const OTHER_RULESET_ID = 8;

// GraphQL envelopes are wire payloads; JSON.parse keeps their `__typename` and
// snake_case spellings out of the identifier namespace.
const parsed = (json: string): unknown => JSON.parse(json) as unknown;

const rulesetsEnvelope = (nodes: string): unknown =>
  parsed(`{"data":{"repository":{"rulesets":{"nodes":[${nodes}]}}}}`);

const node = (id: number, actors: string, typename = 'Repository'): string =>
  `{"databaseId":${String(id)},"source":{"__typename":"${typename}"},"bypassActors":${actors}}`;

const counted = (total: number, nodes: string): string =>
  `{"totalCount":${String(total)},"nodes":${nodes}}`;

const fetchCounts = async (body: unknown, status?: number) => {
  const calls = installApi([
    status === undefined ? { body } : { status, body },
  ]);
  const answer = await fetchBypassActorCountsViaGraphql('token', 'owner/repo');
  return { ...answer, calls };
};

describe('fetchBypassActorCountsViaGraphql answers', () => {
  // `nodes: [null]` is the documented identity-withholding shape and is exactly
  // what the tokens this fallback exists for receive; it must stay acceptable.
  it('counts a repository-owned ruleset whose actor identity is withheld', async () => {
    const answer = await fetchCounts(
      rulesetsEnvelope(node(RULESET_ID, counted(1, '[null]'))),
    );
    expect(answer.failure).toBeNull();
    expect([...answer.counts]).toEqual([[RULESET_ID, 1]]);
    expect(answer.calls.map(({ method, path }) => `${method} ${path}`)).toEqual(
      ['POST /graphql'],
    );
  });

  it('counts a declared-empty list as zero', async () => {
    const answer = await fetchCounts(
      rulesetsEnvelope(node(RULESET_ID, counted(0, '[]'))),
    );
    expect([...answer.counts]).toEqual([[RULESET_ID, 0]]);
  });

  it('omits a ruleset it did not answer for', async () => {
    const answer = await fetchCounts(
      rulesetsEnvelope(node(OTHER_RULESET_ID, counted(0, '[]'))),
    );
    expect(answer.counts.has(RULESET_ID)).toBe(false);
    expect(answer.failure).toBeNull();
  });

  // Last-wins on a repeated id would let one ruleset's count verify another's
  // list, so a repeat drops the id entirely rather than picking a winner.
  it('drops an id that appears more than once', async () => {
    const answer = await fetchCounts(
      rulesetsEnvelope(
        [
          node(RULESET_ID, counted(1, '[null]')),
          node(RULESET_ID, counted(0, '[]')),
          node(OTHER_RULESET_ID, counted(0, '[]')),
        ].join(','),
      ),
    );
    expect([...answer.counts]).toEqual([[OTHER_RULESET_ID, 0]]);
  });
});

describe('fetchBypassActorCountsViaGraphql fails closed', () => {
  // GitHub reports a permission failure as HTTP 200 with a plausible partial
  // `data`. The field-level case is the dangerous one: the count survives as a
  // suppressed `0` that reads exactly like a verified empty list.
  it.each([
    [
      'a null repository beside a NOT_FOUND error',
      '{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a Repository"}]}',
      'Could not resolve to a Repository',
    ],
    [
      'a suppressed count beside a FORBIDDEN error',
      '{"data":{"repository":{"rulesets":{"nodes":[{"databaseId":7,"source":{"__typename":"Repository"},"bypassActors":{"totalCount":0,"nodes":[]}}]}}},"errors":[{"type":"FORBIDDEN","message":"Resource not accessible by integration"}]}',
      'Resource not accessible by integration',
    ],
  ])('reads no count from %s', async (_case, envelope, reported) => {
    const answer = await fetchCounts(parsed(envelope));
    expect([...answer.counts]).toEqual([]);
    expect(answer.failure).toContain(reported);
  });

  it('reports the HTTP status when the request itself failed', async () => {
    const answer = await fetchCounts(
      parsed('{"message":"Bad credentials"}'),
      HTTP_UNAUTHORIZED,
    );
    expect([...answer.counts]).toEqual([]);
    expect(answer.failure).toBe(
      'querying the GraphQL API: HTTP 401 Bad credentials',
    );
  });

  it('makes no request for a repository that is not owner/name', async () => {
    const calls = installApi([]);
    const answer = await fetchBypassActorCountsViaGraphql('token', 'repo');
    expect(calls).toEqual([]);
    expect([...answer.counts]).toEqual([]);
    expect(answer.failure).toContain('is not an owner/name repository');
  });
});

// A count is only ever read from a node that corroborates itself. Each of these
// nodes carries the declared ruleset's id and a count that would verify a
// declared-empty list, so any of them supplying one is a false pass.
describe('fetchBypassActorCountsViaGraphql rejects an uncorroborated count', () => {
  it.each([
    ['the connection is null', 'null'],
    ['the node list is absent', '{"totalCount":0}'],
    ['the count is not a number', '{"totalCount":"0","nodes":[]}'],
    ['the count is negative', '{"totalCount":-1,"nodes":[]}'],
    ['a zero count carries a node', '{"totalCount":0,"nodes":[null]}'],
    ['a non-zero count carries none', '{"totalCount":2,"nodes":[]}'],
  ])('supplies no count when %s', async (_case, actors) => {
    const answer = await fetchCounts(
      rulesetsEnvelope(node(RULESET_ID, actors)),
    );
    expect(answer.counts.has(RULESET_ID)).toBe(false);
    expect(answer.failure).toBeNull();
  });

  it.each([
    [
      'the id is missing',
      '{"source":{"__typename":"Repository"},"bypassActors":{"totalCount":0,"nodes":[]}}',
    ],
    // Org-inherited rulesets are outside this declaration's authority, the same
    // filter the REST loader applies; an org node carrying the repository
    // ruleset's id must not answer for it.
    [
      'the ruleset is org-owned',
      node(RULESET_ID, counted(0, '[]'), 'Organization'),
    ],
    ['the rulesets connection is null', ''],
  ])('supplies no count when %s', async (_case, nodeJson) => {
    const answer = await fetchCounts(
      nodeJson === ''
        ? parsed('{"data":{"repository":{"rulesets":null}}}')
        : rulesetsEnvelope(nodeJson),
    );
    expect(answer.counts.has(RULESET_ID)).toBe(false);
    expect(answer.failure).toBeNull();
  });
});

describe('fetchBypassActorCountsViaGraphql query', () => {
  it('asks only for repository-owned rulesets and one corroborating actor', async () => {
    const answer = await fetchCounts(rulesetsEnvelope(''));
    const [call] = answer.calls;
    expect(call?.path).toBe('/graphql');
    expect(call?.method).toBe('POST');
    const query = graphqlQuery(call);
    expect(query).toContain('includeParents: false');
    expect(query).toContain('bypassActors(first: 1) { totalCount nodes');
    expect(query).toContain('databaseId');
  });
});
