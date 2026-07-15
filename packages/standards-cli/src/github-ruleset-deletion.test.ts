import { afterEach, describe, expect, it } from 'bun:test';
import { HTTP_NO_CONTENT, HTTP_OK } from './github-api';
import { applyPrefetchedRulesets } from './github-apply';
import {
  declaredDefaultBranchProtection,
  defaultBranchResponse,
} from './github-default-branch-test-fixture';
import { deleteVerifiedUndeclaredRuleset } from './github-ruleset-deletion';
import { declaredRuleset } from './github-ruleset-test-fixture';
import type { GithubSettings } from './github-settings-value';

const originalFetch = globalThis.fetch;
const OLD_ID = 2;
const CANONICAL_ID = 1;
const SOURCE_TYPE = 'source_type';

const ruleset = (
  name: string,
  id = OLD_ID,
  target = 'branch',
): Record<string, unknown> => ({
  ...declaredRuleset(name),
  id,
  source: 'owner/repo',
  [SOURCE_TYPE]: 'Repository',
  target,
});

const settings = (): GithubSettings => ({
  defaultBranchProtection: declaredDefaultBranchProtection,
  environments: [],
  repository: {},
  rulesets: [declaredRuleset('Canonical')],
});

const response = (status: number, body: unknown = null): Response =>
  new Response(body === null ? null : JSON.stringify(body), { status });

const runDeletion = () =>
  deleteVerifiedUndeclaredRuleset({
    declaredNames: new Set(['Canonical']),
    defaultBranchProtection: declaredDefaultBranchProtection,
    liveRuleset: ruleset('Old'),
    name: 'Old',
    repo: 'owner/repo',
    token: 'token',
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ruleset deletion safety proof', () => {
  it('does not delete when GitHub ignores a declared ruleset update', async () => {
    const actions: Array<string> = [];
    let deleteCount = 0;
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (method === 'PUT') {
          return Promise.resolve(response(HTTP_OK, {}));
        }
        if (method === 'DELETE') {
          deleteCount += 1;
          return Promise.resolve(response(HTTP_NO_CONTENT));
        }
        if (url.includes('/rulesets?')) {
          return Promise.resolve(
            response(HTTP_OK, [
              ruleset('Canonical', CANONICAL_ID),
              ruleset('Old'),
            ]),
          );
        }
        return Promise.resolve(
          response(
            HTTP_OK,
            url.endsWith(`/${CANONICAL_ID}`)
              ? ruleset('Canonical', CANONICAL_ID, 'tag')
              : ruleset('Old'),
          ),
        );
      },
      { preconnect: originalFetch.preconnect },
    );

    await expect(
      applyPrefetchedRulesets({
        declared: settings(),
        live: {
          problem: null,
          rulesets: [ruleset('Canonical', CANONICAL_ID, 'tag'), ruleset('Old')],
        },
        reportAction: (action) => actions.push(action),
        repo: 'owner/repo',
        token: 'token',
      }),
    ).rejects.toThrow('did not converge after apply');
    expect(deleteCount).toBe(0);
    expect(actions).toEqual(['updated ruleset "Canonical"']);
  });

  it('re-proves live classic protection and exact identity before delete', async () => {
    const requests: Array<string> = [];
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? 'GET';
        requests.push(`${method} ${path}`);
        if (method === 'DELETE') {
          return Promise.resolve(response(HTTP_NO_CONTENT));
        }
        return Promise.resolve(
          response(HTTP_OK, defaultBranchResponse(path) ?? ruleset('Old')),
        );
      },
      { preconnect: originalFetch.preconnect },
    );

    expect(await runDeletion()).toBe('deleted undeclared ruleset "Old"');
    expect(requests).toEqual([
      'GET /repos/owner/repo',
      'GET /repos/owner/repo/branches/trunk',
      'GET /repos/owner/repo/branches/trunk/protection',
      'GET /repos/owner/repo',
      'GET /repos/owner/repo/rulesets/2',
      'DELETE /repos/owner/repo/rulesets/2',
    ]);
  });
});

describe('ruleset deletion race handling', () => {
  it.each([
    'branch',
    'protection',
  ] as const)('refuses deletion after %s drift', async (drift) => {
    const methods: Array<string> = [];
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        methods.push(init?.method ?? 'GET');
        if (drift === 'branch' && path === '/repos/owner/repo') {
          return Promise.resolve(
            response(
              HTTP_OK,
              JSON.parse('{"default_branch":"renamed"}') as unknown,
            ),
          );
        }
        if (
          drift === 'protection' &&
          path === '/repos/owner/repo/branches/trunk'
        ) {
          return Promise.resolve(
            response(HTTP_OK, {
              name: 'trunk',
              protected: true,
              protection: { enabled: false },
            }),
          );
        }
        return Promise.resolve(
          response(HTTP_OK, defaultBranchResponse(path) ?? ruleset('Old')),
        );
      },
      { preconnect: originalFetch.preconnect },
    );

    await expect(runDeletion()).rejects.toThrow();
    expect(methods).not.toContain('DELETE');
  });

  it.each([
    ['Renamed', OLD_ID],
    ['Canonical', OLD_ID],
    ['Old', OLD_ID + 1],
  ] as const)('refuses deletion when exact identity becomes %s / %i', async (freshName, freshId) => {
    const methods: Array<string> = [];
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        methods.push(init?.method ?? 'GET');
        return Promise.resolve(
          response(
            HTTP_OK,
            defaultBranchResponse(path) ?? ruleset(freshName, freshId),
          ),
        );
      },
      { preconnect: originalFetch.preconnect },
    );

    await expect(runDeletion()).rejects.toThrow(
      'changed identity or declaration status before deletion',
    );
    expect(methods).not.toContain('DELETE');
  });
});
