import { afterEach, describe, expect, it } from 'bun:test';
import { HTTP_NO_CONTENT, HTTP_OK } from './github-api';
import { applyEnvironment } from './github-environment-apply';

const originalFetch = globalThis.fetch;
const branchPath = 'deployment-branch-policies';
const customPath = 'deployment_protection_rules';
const PROTECTION_RULES = 'protection_rules';
const WAIT_TIMER = 'wait_timer';
const PREVENT_SELF_REVIEW = 'prevent_self_review';
const DEPLOYMENT_BRANCH_POLICY = 'deployment_branch_policy';
const PROTECTED_BRANCHES = 'protected_branches';
const CUSTOM_BRANCH_POLICIES = 'custom_branch_policies';
const DEPLOYMENT_BRANCH_POLICIES = 'deployment_branch_policies';
const TOTAL_COUNT = 'total_count';
const BRANCH_POLICIES = 'branch_policies';
const CUSTOM_PROTECTION_RULES = 'custom_deployment_protection_rules';
const HTTP_ERROR = 500;

const deleteResult = (url: string): Response =>
  url.includes(customPath)
    ? response(HTTP_ERROR, { message: 'custom delete failed' })
    : response(HTTP_NO_CONTENT);

const response = (status: number, body: unknown = null): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });

const environment = (usesCustomBranches: boolean, waitTimer = 5) => ({
  name: 'production',
  [PROTECTION_RULES]: [{ type: WAIT_TIMER, [WAIT_TIMER]: waitTimer }],
  [DEPLOYMENT_BRANCH_POLICY]: {
    [PROTECTED_BRANCHES]: !usesCustomBranches,
    [CUSTOM_BRANCH_POLICIES]: usesCustomBranches,
  },
});

const customRules = (present: boolean) => ({
  [TOTAL_COUNT]: present ? 1 : 0,
  [CUSTOM_PROTECTION_RULES]: present
    ? [
        {
          app: { id: 9, slug: 'external-gate' },
          enabled: true,
          id: 8,
        },
      ]
    : [],
});

const declared = (usesCustomBranches: boolean) => ({
  name: 'production',
  [WAIT_TIMER]: 0,
  [PREVENT_SELF_REVIEW]: false,
  reviewers: [],
  [DEPLOYMENT_BRANCH_POLICY]: {
    [PROTECTED_BRANCHES]: !usesCustomBranches,
    [CUSTOM_BRANCH_POLICIES]: usesCustomBranches,
  },
  [DEPLOYMENT_BRANCH_POLICIES]: usesCustomBranches
    ? [{ name: 'release/*', type: 'branch' }]
    : [],
});

const installFetch = (
  handler: (url: string, method: string) => Response,
  calls: Array<string>,
): void => {
  globalThis.fetch = Object.assign(
    (input: URL | RequestInfo, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push(`${method} ${url}`);
      return Promise.resolve(handler(url, method));
    },
    { preconnect: originalFetch.preconnect },
  );
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('environment reconciliation ordering', () => {
  it('creates non-destructive state before branch and custom-rule deletes', async () => {
    const calls: Array<string> = [];
    const reported: Array<string> = [];
    installFetch((url, method) => {
      if (method === 'PUT' || method === 'POST') {
        return response(HTTP_OK, {});
      }
      if (method === 'DELETE') {
        return response(HTTP_NO_CONTENT);
      }
      if (url.includes(customPath)) {
        return response(HTTP_OK, customRules(true));
      }
      if (url.includes(branchPath)) {
        return response(HTTP_OK, {
          [TOTAL_COUNT]: 1,
          [BRANCH_POLICIES]: [{ id: 7, name: 'old/*', type: 'branch' }],
        });
      }
      return response(HTTP_OK, environment(true));
    }, calls);

    const actions = await applyEnvironment(
      'token',
      'owner/repo',
      declared(true),
      (action) => reported.push(action),
    );

    expect(calls.map((call) => call.split(' ')[0])).toEqual([
      'GET',
      'GET',
      'GET',
      'PUT',
      'POST',
      'DELETE',
      'DELETE',
    ]);
    expect(calls.at(-1)).toContain(customPath);
    expect(reported).toEqual([...actions]);
  });

  it('reports protection before a later branch-policy create failure', async () => {
    const calls: Array<string> = [];
    const reported: Array<string> = [];
    installFetch((url, method) => {
      if (method === 'PUT') {
        return response(HTTP_OK, {});
      }
      if (method === 'POST') {
        return response(HTTP_ERROR, { message: 'create failed' });
      }
      if (url.includes(customPath)) {
        return response(HTTP_OK, customRules(false));
      }
      return response(HTTP_OK, environment(false));
    }, calls);

    await expect(
      applyEnvironment('token', 'owner/repo', declared(true), (action) =>
        reported.push(action),
      ),
    ).rejects.toThrow('creating deployment policy');
    expect(reported).toEqual(['updated environment "production" protection']);
    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });

  it('reports branch deletion before a later custom-rule delete failure', async () => {
    const calls: Array<string> = [];
    const reported: Array<string> = [];
    installFetch((url, method) => {
      if (method === 'PUT') {
        return response(HTTP_OK, {});
      }
      if (method === 'DELETE') {
        return deleteResult(url);
      }
      if (url.includes(customPath)) {
        return response(HTTP_OK, customRules(true));
      }
      if (url.includes(branchPath)) {
        return response(HTTP_OK, {
          [TOTAL_COUNT]: 1,
          [BRANCH_POLICIES]: [{ id: 7, name: 'old/*', type: 'branch' }],
        });
      }
      return response(HTTP_OK, environment(true));
    }, calls);

    await expect(
      applyEnvironment('token', 'owner/repo', declared(false), (action) =>
        reported.push(action),
      ),
    ).rejects.toThrow('deleting custom deployment protection rule');
    expect(reported).toEqual([
      'updated environment "production" protection',
      'deleted undeclared deployment policy "old/*" from environment "production"',
    ]);
  });
});
