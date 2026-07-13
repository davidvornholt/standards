import { afterEach, describe, expect, it } from 'bun:test';
import { HTTP_NO_CONTENT, HTTP_NOT_FOUND, HTTP_OK } from './github-api';
import { applyEnvironment } from './github-environment-apply';

const originalFetch = globalThis.fetch;

const declared = JSON.parse(
  '{"name":"standards-sync","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true},"deployment_branch_policies":[{"name":"main","type":"branch"}]}',
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

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('applyEnvironment', () => {
  it('creates protection and the exact main deployment policy without secret APIs', async () => {
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

    expect(actions).toHaveLength(2);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT', 'POST']);
    expect(calls.every((call) => !call.url.includes('secrets'))).toBe(true);
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual(
      JSON.parse(
        '{"wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}',
      ),
    );
    expect(JSON.parse(calls[2]?.body ?? '{}')).toEqual({
      name: 'main',
      type: 'branch',
    });
  });

  it('does not mutate an already converged environment', async () => {
    const methods: Array<string> = [];
    globalThis.fetch = mockFetch((input, init) => {
      methods.push(init?.method ?? 'GET');
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
        JSON.parse(
          '{"name":"standards-sync","protection_rules":[],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}',
        ),
      );
    });

    expect(await applyEnvironment('token', 'owner/repo', declared)).toEqual([]);
    expect(methods).toEqual(['GET', 'GET']);
  });

  it('deletes an undeclared deployment branch policy', async () => {
    const methods: Array<string> = [];
    globalThis.fetch = mockFetch((input, init) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'DELETE') {
        return response(HTTP_NO_CONTENT);
      }
      if (String(input).includes('deployment-branch-policies')) {
        const isFirstPage = String(input).includes('&page=1');
        return response(
          HTTP_OK,
          JSON.parse(
            `{"total_count":2,"branch_policies":[${
              isFirstPage
                ? '{"id":7,"name":"main","type":"branch"}'
                : '{"id":8,"name":"release","type":"branch"}'
            }]}`,
          ),
        );
      }
      return response(
        HTTP_OK,
        JSON.parse(
          '{"name":"standards-sync","protection_rules":[],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}',
        ),
      );
    });

    const actions = await applyEnvironment('token', 'owner/repo', declared);

    expect(methods).toEqual(['GET', 'GET', 'GET', 'DELETE']);
    expect(actions).toEqual([
      'deleted undeclared deployment policy "release" from environment "standards-sync"',
    ]);
  });
});
