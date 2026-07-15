import { afterEach, describe, expect, it } from 'bun:test';
import { applyDefaultBranchProtection } from './github-default-branch-apply';
import { declaredDefaultBranchProtection } from './github-default-branch-test-fixture';

const originalFetch = globalThis.fetch;
const HTTP_NO_CONTENT = 204;
const HTTP_OK = 200;
const DEFAULT_BRANCH = 'default_branch';
const REQUIRED_SIGNATURES = 'required_signatures';

type InvalidState = {
  readonly body: Readonly<Record<string, unknown>>;
  readonly expected: string;
  readonly name: string;
};

const invalidStates = [
  {
    body: { [DEFAULT_BRANCH]: 'renamed' },
    expected: 'changed from "trunk" to "renamed" before protection mutation',
    name: 'renamed',
  },
  {
    body: { [DEFAULT_BRANCH]: 7 },
    expected: 'invalid repository default branch',
    name: 'malformed',
  },
] as const satisfies ReadonlyArray<InvalidState>;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('default branch protection mutation guard', () => {
  it.each([
    ...invalidStates,
  ])('checks identity after the generic guard and prevents DELETE when $name', async ({
    body,
    expected,
  }) => {
    const events: Array<string> = [];
    const actions: Array<string> = [];
    let repositoryReads = 0;
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? 'GET';
        events.push(`${method} ${path}`);
        if (method === 'PUT') {
          return Promise.resolve(Response.json({}, { status: HTTP_OK }));
        }
        if (method === 'DELETE') {
          return Promise.resolve(
            new Response(null, { status: HTTP_NO_CONTENT }),
          );
        }
        repositoryReads += 1;
        return Promise.resolve(
          Response.json(
            repositoryReads === 1 ? { [DEFAULT_BRANCH]: 'trunk' } : body,
          ),
        );
      },
      { preconnect: originalFetch.preconnect },
    );

    await expect(
      applyDefaultBranchProtection({
        beforeMutation: () => {
          events.push('generic guard');
          return Promise.resolve();
        },
        declared: declaredDefaultBranchProtection,
        live: {
          branch: 'trunk',
          classicProtection: true,
          problem: null,
          protection: {
            ...declaredDefaultBranchProtection,
            [REQUIRED_SIGNATURES]: true,
          },
          unverifiable: false,
        },
        reportAction: (action) => actions.push(action),
        repo: 'owner/repo',
        token: 'token',
      }),
    ).rejects.toThrow(expected);
    expect(events).toEqual([
      'generic guard',
      'GET /repos/owner/repo',
      'PUT /repos/owner/repo/branches/trunk/protection',
      'generic guard',
      'GET /repos/owner/repo',
    ]);
    expect(actions).toEqual([
      'updated classic protection for default branch "trunk"',
    ]);
  });
});
