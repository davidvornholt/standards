import { afterEach, describe, expect, it } from 'bun:test';
import { HTTP_NO_CONTENT, HTTP_NOT_FOUND, HTTP_OK } from './github-api';
import { applyEnvironment } from './github-environment-apply';

const originalFetch = globalThis.fetch;
const DEPLOYMENT_BRANCH_POLICY = 'deployment_branch_policy';
const PROTECTION_RULES = 'protection_rules';
const PROTECTED_BRANCHES = 'protected_branches';
const CUSTOM_BRANCH_POLICIES = 'custom_branch_policies';
const TOTAL_COUNT = 'total_count';
const BRANCH_POLICIES = 'branch_policies';
const PAGE_SIZE = 100;

const declared = JSON.parse(
  '{"name":"standards-sync","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false},"deployment_branch_policies":[]}',
) as Record<string, unknown>;

const mockFetch = (
  handler: (input: URL | RequestInfo, init?: RequestInit) => Response,
): typeof fetch =>
  Object.assign(
    (input: URL | RequestInfo, init?: RequestInit) =>
      Promise.resolve(handler(input, init)),
    { preconnect: originalFetch.preconnect },
  );

const response = (status: number, body: unknown = null): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const liveEnvironment = (
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  name: 'standards-sync',
  [PROTECTION_RULES]: [],
  [DEPLOYMENT_BRANCH_POLICY]: {
    [PROTECTED_BRANCHES]: true,
    [CUSTOM_BRANCH_POLICIES]: false,
  },
  ...overrides,
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('applyEnvironment', () => {
  it('creates protected-branch deployment mode without secret APIs', async () => {
    const calls: Array<{ method: string; url: string; body: string | null }> =
      [];
    globalThis.fetch = mockFetch((input, init) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (init?.method === 'GET') {
        return response(HTTP_NOT_FOUND, { message: 'Not Found' });
      }
      return response(HTTP_OK, {});
    });

    const actions = await applyEnvironment('token', 'owner/repo', declared);

    expect(actions).toHaveLength(1);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(calls.every((call) => !call.url.includes('secrets'))).toBe(true);
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual(
      JSON.parse(
        '{"wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}',
      ),
    );
  });

  it('does not mutate an already converged environment', async () => {
    const methods: Array<string> = [];
    globalThis.fetch = mockFetch((_input, init) => {
      methods.push(init?.method ?? 'GET');
      return response(HTTP_OK, liveEnvironment());
    });

    expect(await applyEnvironment('token', 'owner/repo', declared)).toEqual([]);
    expect(methods).toEqual(['GET']);
  });

  it('deletes custom policies before enabling protected-branch mode', async () => {
    const methods: Array<string> = [];
    globalThis.fetch = mockFetch((input, init) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'DELETE') {
        return response(HTTP_NO_CONTENT);
      }
      if (String(input).includes('deployment-branch-policies')) {
        return response(
          HTTP_OK,
          JSON.parse(
            '{"total_count":1,"branch_policies":[{"id":7,"name":"main","type":"branch"}]}',
          ),
        );
      }
      return response(
        HTTP_OK,
        liveEnvironment({
          [DEPLOYMENT_BRANCH_POLICY]: {
            [PROTECTED_BRANCHES]: false,
            [CUSTOM_BRANCH_POLICIES]: true,
          },
        }),
      );
    });

    const actions = await applyEnvironment('token', 'owner/repo', declared);

    expect(methods).toEqual(['GET', 'GET', 'DELETE', 'PUT']);
    expect(actions).toEqual([
      'deleted undeclared deployment policy "main" from environment "standards-sync"',
      'updated environment "standards-sync" protection',
    ]);
  });
});

describe('applyEnvironment validation', () => {
  it('fails without writes when protection rules are malformed', async () => {
    const methods: Array<string> = [];
    globalThis.fetch = mockFetch((_input, init) => {
      methods.push(init?.method ?? 'GET');
      return response(
        HTTP_OK,
        liveEnvironment({ [PROTECTION_RULES]: 'corrupt' }),
      );
    });

    await expect(
      applyEnvironment('token', 'owner/repo', declared),
    ).rejects.toThrow('invalid environment response');
    expect(methods).toEqual(['GET']);
  });

  it('fails without writes when a deployment policy is malformed', async () => {
    const calls: Array<string> = [];
    globalThis.fetch = mockFetch((input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return String(input).includes('deployment-branch-policies')
        ? response(HTTP_OK, { [TOTAL_COUNT]: 1, [BRANCH_POLICIES]: [{}] })
        : response(
            HTTP_OK,
            liveEnvironment({
              [DEPLOYMENT_BRANCH_POLICY]: {
                [PROTECTED_BRANCHES]: false,
                [CUSTOM_BRANCH_POLICIES]: true,
              },
            }),
          );
    });

    await expect(
      applyEnvironment('token', 'owner/repo', declared),
    ).rejects.toThrow('invalid deployment policy');
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.startsWith('GET '))).toBe(true);
  });

  it('fails when deployment-policy totals change between pages', async () => {
    let page = 0;
    globalThis.fetch = mockFetch((input) => {
      if (!String(input).includes('deployment-branch-policies')) {
        return response(
          HTTP_OK,
          liveEnvironment({
            [DEPLOYMENT_BRANCH_POLICY]: {
              [PROTECTED_BRANCHES]: false,
              [CUSTOM_BRANCH_POLICIES]: true,
            },
          }),
        );
      }
      page += 1;
      return response(HTTP_OK, {
        [TOTAL_COUNT]: page === 1 ? PAGE_SIZE + 1 : PAGE_SIZE,
        [BRANCH_POLICIES]: Array.from(
          { length: page === 1 ? PAGE_SIZE : 1 },
          (_, index) => ({
            id: page * PAGE_SIZE * PAGE_SIZE + index,
            name: `p-${page}-${index}`,
            type: 'branch',
          }),
        ),
      });
    });

    await expect(
      applyEnvironment('token', 'owner/repo', declared),
    ).rejects.toThrow('changed total_count during pagination');
  });
});
