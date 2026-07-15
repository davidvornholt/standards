import { afterEach, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { applyDefaultBranchProtection } from './github-default-branch-apply';

const originalFetch = globalThis.fetch;
const declared = JSON.parse(
  await readFile(
    new URL('../../../.github/settings.json', import.meta.url),
    'utf8',
  ),
).default_branch_protection as Record<string, unknown>;
const details = JSON.parse(
  '{"allow_deletions":{"enabled":false},"allow_force_pushes":{"enabled":false},"allow_fork_syncing":{"enabled":false},"block_creations":{"enabled":false},"enforce_admins":{"enabled":true},"lock_branch":{"enabled":false},"required_conversation_resolution":{"enabled":true},"required_linear_history":{"enabled":true},"required_pull_request_reviews":{"dismiss_stale_reviews":true,"require_code_owner_reviews":false,"require_last_push_approval":false,"required_approving_review_count":0},"required_signatures":{"enabled":false},"required_status_checks":{"checks":[{"app_id":15368,"context":"check"},{"app_id":15368,"context":"pr-title"}],"contexts":["check","pr-title"],"strict":true}}',
) as Record<string, unknown>;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('fails when the branch summary reports classic protection disabled', async () => {
  const calls: Array<{ readonly method: string; readonly path: string }> = [];
  globalThis.fetch = Object.assign(
    (input: URL | RequestInfo, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path });
      if (method === 'PUT') {
        return Promise.resolve(Response.json({}));
      }
      let body: unknown = details;
      if (path === '/repos/owner/repo') {
        body = JSON.parse('{"default_branch":"trunk"}');
      } else if (path === '/repos/owner/repo/branches/trunk') {
        body = {
          name: 'trunk',
          protected: true,
          protection: { enabled: false },
        };
      }
      return Promise.resolve(Response.json(body));
    },
    { preconnect: originalFetch.preconnect },
  );

  await expect(
    applyDefaultBranchProtection({
      declared,
      live: {
        branch: 'trunk',
        classicProtection: false,
        problem: null,
        protection: null,
        unverifiable: false,
      },
      reportAction: () => undefined,
      repo: 'owner/repo',
      token: 'token',
    }),
  ).rejects.toThrow('did not match declared protection after update');
  expect(calls).toEqual([
    { method: 'PUT', path: '/repos/owner/repo/branches/trunk/protection' },
    { method: 'GET', path: '/repos/owner/repo' },
    { method: 'GET', path: '/repos/owner/repo/branches/trunk' },
    {
      method: 'GET',
      path: '/repos/owner/repo/branches/trunk/protection',
    },
    { method: 'GET', path: '/repos/owner/repo' },
  ]);
});
