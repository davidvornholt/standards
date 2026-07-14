import { afterEach, describe, expect, it } from 'bun:test';
import { applyEnvironment } from './github-environment-apply';

const originalFetch = globalThis.fetch;

const response = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('custom deployment protection validation', () => {
  it('performs no writes when the custom-rule collection is malformed', async () => {
    const methods: Array<string> = [];
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        return Promise.resolve(
          response(
            String(input).includes('deployment_protection_rules')
              ? (JSON.parse(
                  '{"total_count":1,"custom_deployment_protection_rules":[{"app":{"id":9,"slug":"gate"},"enabled":true,"id":0}]}',
                ) as unknown)
              : (JSON.parse(
                  '{"name":"production","protection_rules":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}',
                ) as unknown),
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
          '{"name":"production","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}',
        ) as Record<string, unknown>,
      ),
    ).rejects.toThrow('invalid custom protection rule identity');
    expect(methods).toEqual(['GET', 'GET']);
  });
});
