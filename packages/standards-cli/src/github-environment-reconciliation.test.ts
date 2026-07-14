import { afterEach, describe, expect, it } from 'bun:test';
import { HTTP_NO_CONTENT, HTTP_OK } from './github-api';
import { applyEnvironment } from './github-environment-apply';

const originalFetch = globalThis.fetch;
const customPath = 'deployment_protection_rules';
const PROTECTION_RULES = 'protection_rules';
const WAIT_TIMER = 'wait_timer';
const PREVENT_SELF_REVIEW = 'prevent_self_review';
const DEPLOYMENT_BRANCH_POLICY = 'deployment_branch_policy';
const PROTECTED_BRANCHES = 'protected_branches';
const CUSTOM_BRANCH_POLICIES = 'custom_branch_policies';
const TOTAL_COUNT = 'total_count';
const CUSTOM_PROTECTION_RULES = 'custom_deployment_protection_rules';
const HTTP_ERROR = 500;

const response = (status: number, body: unknown = null): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });

const environment = (usesCustomBranches: boolean, waitTimer = 5) => ({
  name: 'production',
  [PROTECTION_RULES]: [
    { id: 1, type: 'branch_policy' },
    { type: WAIT_TIMER, [WAIT_TIMER]: waitTimer },
  ],
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

const declared = {
  name: 'production',
  [WAIT_TIMER]: 0,
  [PREVENT_SELF_REVIEW]: false,
  reviewers: [],
  [DEPLOYMENT_BRANCH_POLICY]: {
    [PROTECTED_BRANCHES]: true,
    [CUSTOM_BRANCH_POLICIES]: false,
  },
};

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
  it('updates protection before deleting custom rules without branch-policy requests', async () => {
    const calls: Array<string> = [];
    const reported: Array<string> = [];
    installFetch((url, method) => {
      if (method === 'PUT') {
        return response(HTTP_OK, {});
      }
      if (method === 'DELETE') {
        return response(HTTP_NO_CONTENT);
      }
      if (url.includes(customPath)) {
        return response(HTTP_OK, customRules(true));
      }
      return response(HTTP_OK, environment(true));
    }, calls);

    const actions = await applyEnvironment(
      'token',
      'owner/repo',
      declared,
      (action) => reported.push(action),
    );

    expect(calls.map((call) => call.split(' ')[0])).toEqual([
      'GET',
      'GET',
      'PUT',
      'DELETE',
    ]);
    expect(calls.at(-1)).toContain(customPath);
    expect(
      calls.every((call) => !call.includes('deployment-branch-policies')),
    ).toBe(true);
    expect(reported).toEqual([...actions]);
  });

  it('reports protection immediately before a later custom-rule delete failure', async () => {
    const calls: Array<string> = [];
    const reported: Array<string> = [];
    installFetch((url, method) => {
      if (method === 'PUT') {
        return response(HTTP_OK, {});
      }
      if (method === 'DELETE') {
        return response(HTTP_ERROR, { message: 'custom delete failed' });
      }
      if (url.includes(customPath)) {
        return response(HTTP_OK, customRules(true));
      }
      return response(HTTP_OK, environment(true));
    }, calls);

    await expect(
      applyEnvironment('token', 'owner/repo', declared, (action) =>
        reported.push(action),
      ),
    ).rejects.toThrow('deleting custom deployment protection rule');
    expect(reported).toEqual(['updated environment "production" protection']);
  });
});
