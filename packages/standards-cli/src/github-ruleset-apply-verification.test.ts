import { afterEach, describe, expect, it } from 'bun:test';
import { HTTP_NO_CONTENT, HTTP_OK } from './github-api';
import { applyPrefetchedRulesets } from './github-apply';
import { declaredRuleset } from './github-ruleset-test-fixture';
import type { GithubSettings } from './github-settings';

const originalFetch = globalThis.fetch;
const CANONICAL_ID = 1;
const OLD_ID = 2;
const FRESH_OLD_ID = 3;

const response = (status: number, body: unknown = null): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });

const ruleset = (
  id: number,
  name: string,
  target = 'branch',
): Record<string, unknown> => ({
  ...declaredRuleset(name),
  ...(JSON.parse('{"source_type":"Repository"}') as Record<string, unknown>),
  id,
  source: 'owner/repo',
  target,
});

const settings = (name: string): GithubSettings => ({
  defaultBranchProtection: null,
  environments: [],
  repository: {},
  rulesets: [declaredRuleset(name)],
});

const installFetch = (
  handler: (method: string, url: string) => Response,
): void => {
  globalThis.fetch = Object.assign(
    (input: URL | RequestInfo, init?: RequestInit) =>
      Promise.resolve(handler(init?.method ?? 'GET', String(input))),
    { preconnect: originalFetch.preconnect },
  );
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ruleset apply deletion guard', () => {
  it('does not delete when GitHub ignores a declared ruleset update', async () => {
    const actions: Array<string> = [];
    let deleteCount = 0;
    installFetch((method, url) => {
      if (method === 'PUT') {
        return response(HTTP_OK, {});
      }
      if (method === 'DELETE') {
        deleteCount += 1;
        return response(HTTP_NO_CONTENT);
      }
      if (url.includes('/rulesets?')) {
        return response(HTTP_OK, [
          ruleset(CANONICAL_ID, 'Canonical'),
          ruleset(OLD_ID, 'Old'),
        ]);
      }
      return response(
        HTTP_OK,
        url.endsWith(`/${CANONICAL_ID}`)
          ? ruleset(CANONICAL_ID, 'Canonical', 'tag')
          : ruleset(OLD_ID, 'Old'),
      );
    });

    const applied = applyPrefetchedRulesets({
      declared: settings('Canonical'),
      live: {
        problem: null,
        rulesets: [
          ruleset(CANONICAL_ID, 'Canonical', 'tag'),
          ruleset(OLD_ID, 'Old'),
        ],
      },
      reportAction: (action) => actions.push(action),
      repo: 'owner/repo',
      token: 'token',
    });

    await expect(applied).rejects.toThrow('did not converge after apply');
    expect(deleteCount).toBe(0);
    expect(actions).toEqual(['updated ruleset "Canonical"']);
  });
});

describe('ruleset apply readback', () => {
  it('deletes only the fresh undeclared set and verifies the final state', async () => {
    const actions: Array<string> = [];
    const requests: Array<string> = [];
    const listResponses = [
      [ruleset(CANONICAL_ID, 'Canonical'), ruleset(FRESH_OLD_ID, 'Fresh old')],
      [ruleset(CANONICAL_ID, 'Canonical')],
    ];
    const details = new Map([
      [`/${CANONICAL_ID}`, ruleset(CANONICAL_ID, 'Canonical')],
      [`/${FRESH_OLD_ID}`, ruleset(FRESH_OLD_ID, 'Fresh old')],
    ]);
    let listReads = 0;
    installFetch((method, rawUrl) => {
      const url = new URL(rawUrl);
      requests.push(`${method} ${url.pathname}`);
      if (method === 'PUT') {
        return response(HTTP_OK, {});
      }
      if (method === 'DELETE') {
        return response(HTTP_NO_CONTENT);
      }
      if (url.search.length > 0) {
        const listed = listResponses[listReads] ?? [];
        listReads += 1;
        return response(HTTP_OK, listed);
      }
      return response(HTTP_OK, details.get(url.pathname.slice(-2)));
    });

    await applyPrefetchedRulesets({
      declared: settings('Canonical'),
      live: {
        problem: null,
        rulesets: [
          ruleset(CANONICAL_ID, 'Canonical', 'tag'),
          ruleset(OLD_ID, 'Stale old'),
        ],
      },
      reportAction: (action) => actions.push(action),
      repo: 'owner/repo',
      token: 'token',
    });

    expect(requests).toEqual([
      'PUT /repos/owner/repo/rulesets/1',
      'GET /repos/owner/repo/rulesets',
      'GET /repos/owner/repo/rulesets/1',
      'GET /repos/owner/repo/rulesets/3',
      'DELETE /repos/owner/repo/rulesets/3',
      'GET /repos/owner/repo/rulesets',
      'GET /repos/owner/repo/rulesets/1',
    ]);
    expect(actions).toEqual([
      'updated ruleset "Canonical"',
      'deleted undeclared ruleset "Fresh old"',
    ]);
  });

  it('fails when state drifts after a successful delete', async () => {
    const actions: Array<string> = [];
    const listResponses = [
      [ruleset(CANONICAL_ID, 'Canonical'), ruleset(OLD_ID, 'Old')],
      [ruleset(CANONICAL_ID, 'Canonical')],
    ];
    const details = new Map([
      [`1:/${CANONICAL_ID}`, ruleset(CANONICAL_ID, 'Canonical')],
      [`1:/${OLD_ID}`, ruleset(OLD_ID, 'Old')],
      [`2:/${CANONICAL_ID}`, ruleset(CANONICAL_ID, 'Canonical', 'tag')],
    ]);
    let listReads = 0;
    installFetch((method, url) => {
      if (method === 'DELETE') {
        return response(HTTP_NO_CONTENT);
      }
      if (url.includes('/rulesets?')) {
        const listed = listResponses[listReads] ?? [];
        listReads += 1;
        return response(HTTP_OK, listed);
      }
      return response(
        HTTP_OK,
        details.get(`${listReads}:${new URL(url).pathname.slice(-2)}`),
      );
    });

    const applied = applyPrefetchedRulesets({
      declared: settings('Canonical'),
      live: {
        problem: null,
        rulesets: [ruleset(CANONICAL_ID, 'Canonical'), ruleset(OLD_ID, 'Old')],
      },
      reportAction: (action) => actions.push(action),
      repo: 'owner/repo',
      token: 'token',
    });

    await expect(applied).rejects.toThrow('rulesets did not converge');
    expect(actions).toEqual(['deleted undeclared ruleset "Old"']);
  });
});
