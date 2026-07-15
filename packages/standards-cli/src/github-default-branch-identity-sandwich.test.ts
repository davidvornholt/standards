import { afterEach, describe, expect, it } from 'bun:test';
import { applyDefaultBranchProtection } from './github-default-branch-apply';
import {
  declaredDefaultBranchProtection,
  defaultBranchResponse,
} from './github-default-branch-test-fixture';
import { deleteVerifiedUndeclaredRuleset } from './github-ruleset-deletion';

const originalFetch = globalThis.fetch;
const HTTP_NO_CONTENT = 204;
const HTTP_OK = 200;
const DEFAULT_BRANCH = 'default_branch';
const MALFORMED_DEFAULT_BRANCH = 7;

type Flow = 'protection update' | 'ruleset deletion';
type TrailingState = 'malformed' | 'renamed';

const response = (status: number, body: unknown = null): Response =>
  new Response(body === null ? null : JSON.stringify(body), { status });

const runFlow = (flow: Flow): Promise<unknown> => {
  if (flow === 'protection update') {
    return applyDefaultBranchProtection({
      declared: declaredDefaultBranchProtection,
      live: {
        branch: 'trunk',
        classicProtection: false,
        problem: null,
        protection: null,
        unverifiable: false,
      },
      reportAction: () => undefined,
      repo: 'owner/repo',
      token: 'token',
    });
  }
  return deleteVerifiedUndeclaredRuleset({
    declaredNames: new Set(['Canonical']),
    defaultBranchProtection: declaredDefaultBranchProtection,
    liveRuleset: { id: 2, name: 'Old' },
    name: 'Old',
    repo: 'owner/repo',
    token: 'token',
  });
};

const expectedRequests = (flow: Flow): Array<string> => [
  ...(flow === 'protection update'
    ? ['PUT /repos/owner/repo/branches/trunk/protection']
    : []),
  'GET /repos/owner/repo',
  'GET /repos/owner/repo/branches/trunk',
  'GET /repos/owner/repo/branches/trunk/protection',
  'GET /repos/owner/repo',
];

const repositoryBody = (
  read: number,
  trailing: TrailingState,
): Readonly<Record<string, unknown>> => {
  if (read === 1) {
    return { [DEFAULT_BRANCH]: 'trunk' };
  }
  return {
    [DEFAULT_BRANCH]:
      trailing === 'renamed' ? 'renamed' : MALFORMED_DEFAULT_BRANCH,
  };
};

const fetchFor = (
  requests: Array<string>,
  trailing: TrailingState,
): typeof fetch => {
  let repositoryReads = 0;
  return Object.assign(
    (input: URL | RequestInfo, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${path}`);
      if (method === 'PUT') {
        return Promise.resolve(response(HTTP_OK, {}));
      }
      if (method === 'DELETE') {
        return Promise.resolve(response(HTTP_NO_CONTENT));
      }
      if (path === '/repos/owner/repo') {
        repositoryReads += 1;
        return Promise.resolve(
          response(HTTP_OK, repositoryBody(repositoryReads, trailing)),
        );
      }
      return Promise.resolve(
        response(HTTP_OK, defaultBranchResponse(path) ?? {}),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('default branch protection identity sandwich', () => {
  it.each(
    (
      [
        'protection update',
        'ruleset deletion',
      ] as const satisfies ReadonlyArray<Flow>
    ).flatMap((flow) =>
      (
        ['renamed', 'malformed'] as const satisfies ReadonlyArray<TrailingState>
      ).map((trailing) => [flow, trailing] as const),
    ),
  )('fails %s when trailing repository identity is %s', async (flow, trailing) => {
    const requests: Array<string> = [];
    globalThis.fetch = fetchFor(requests, trailing);

    const expected =
      trailing === 'renamed'
        ? 'changed from "trunk" to "renamed" during protection verification'
        : 'invalid repository default branch';
    await expect(runFlow(flow)).rejects.toThrow(expected);
    expect(requests).toEqual(expectedRequests(flow));
  });
});
