import { afterEach, describe, expect, it } from 'bun:test';
import { applyEnvironment } from './github-environment-apply';

const originalFetch = globalThis.fetch;
const PAGE_SIZE = 100;
const TOTAL_COUNT = 'total_count';
const BRANCH_POLICIES = 'branch_policies';
const NODE_ID = 'node_id';

const response = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('environment deployment-policy pagination', () => {
  it('fails when totals change between pages', async () => {
    let page = 0;
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes('deployment-branch-policies')) {
          page += 1;
          return Promise.resolve(
            response({
              [TOTAL_COUNT]: page === 1 ? PAGE_SIZE + 1 : PAGE_SIZE,
              [BRANCH_POLICIES]: Array.from(
                { length: page === 1 ? PAGE_SIZE : 1 },
                (_, index) => ({
                  id: page * PAGE_SIZE * PAGE_SIZE + index,
                  name: `p-${page}-${index}`,
                  [NODE_ID]: `node-${page}-${index}`,
                }),
              ),
            }),
          );
        }
        if (url.includes('deployment_protection_rules')) {
          return Promise.resolve(
            response(
              JSON.parse(
                '{"total_count":0,"custom_deployment_protection_rules":[]}',
              ) as unknown,
            ),
          );
        }
        return Promise.resolve(
          response(
            JSON.parse(
              '{"name":"production","protection_rules":[],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}',
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
          '{"name":"production","wait_timer":0,"prevent_self_review":false,"reviewers":[],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true},"deployment_branch_policies":[]}',
        ) as Record<string, unknown>,
      ),
    ).rejects.toThrow('changed total_count during pagination');
  });
});
