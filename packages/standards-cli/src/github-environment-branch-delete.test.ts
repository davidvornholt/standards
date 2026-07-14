import { afterEach, describe, expect, it } from 'bun:test';
import { HTTP_OK } from './github-api';
import { applyEnvironment } from './github-environment-apply';

const originalFetch = globalThis.fetch;
const HTTP_ERROR = 500;

const response = (status: number, body: unknown = null): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('environment branch-policy deletion failure', () => {
  it('reports prior protection and branch creation before failing', async () => {
    const reported: Array<string> = [];
    const methods: Array<string> = [];
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const url = String(input);
        methods.push(method);
        if (method === 'PUT' || method === 'POST') {
          return Promise.resolve(response(HTTP_OK, {}));
        }
        if (method === 'DELETE') {
          return Promise.resolve(
            response(HTTP_ERROR, { message: 'delete failed' }),
          );
        }
        if (url.includes('deployment_protection_rules')) {
          return Promise.resolve(
            response(
              HTTP_OK,
              JSON.parse(
                '{"total_count":0,"custom_deployment_protection_rules":[]}',
              ) as unknown,
            ),
          );
        }
        if (url.includes('deployment-branch-policies')) {
          return Promise.resolve(
            response(
              HTTP_OK,
              JSON.parse(
                '{"total_count":1,"branch_policies":[{"id":7,"name":"old/*","type":"branch"}]}',
              ) as unknown,
            ),
          );
        }
        return Promise.resolve(
          response(
            HTTP_OK,
            JSON.parse(
              '{"name":"production","protection_rules":[{"type":"wait_timer","wait_timer":5}],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}',
            ) as unknown,
          ),
        );
      },
      { preconnect: originalFetch.preconnect },
    );

    await expect(
      applyEnvironment(
        'token',
        'owner/repo',
        JSON.parse(
          '{"name":"production","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true},"deployment_branch_policies":[{"name":"release/*","type":"branch"}]}',
        ) as Record<string, unknown>,
        (action) => reported.push(action),
      ),
    ).rejects.toThrow('deleting deployment policy');
    expect(reported).toEqual([
      'updated environment "production" protection',
      'created deployment policy "release/*" for environment "production"',
    ]);
    expect(methods).toEqual(['GET', 'GET', 'GET', 'PUT', 'POST', 'DELETE']);
  });
});
