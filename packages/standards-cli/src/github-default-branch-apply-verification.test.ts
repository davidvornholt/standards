import { afterEach, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { applyDefaultBranchProtection } from './github-default-branch-apply';

const originalFetch = globalThis.fetch;
const HTTP_OK = 200;
const declared = JSON.parse(
  await readFile(
    new URL('../../../.github/settings.json', import.meta.url),
    'utf8',
  ),
).default_branch_protection as Record<string, unknown>;

const response = (body: unknown): Response =>
  Response.json(body, { status: HTTP_OK });

const protectionResponse = (): Record<string, unknown> =>
  JSON.parse(
    '{"allow_deletions":{"enabled":false},"allow_force_pushes":{"enabled":false},"allow_fork_syncing":{"enabled":false},"block_creations":{"enabled":false},"enforce_admins":{"enabled":true},"lock_branch":{"enabled":false},"required_conversation_resolution":{"enabled":true},"required_linear_history":{"enabled":true},"required_pull_request_reviews":{"dismiss_stale_reviews":true,"require_code_owner_reviews":false,"require_last_push_approval":false,"required_approving_review_count":0},"required_signatures":{"enabled":false},"required_status_checks":{"checks":[{"app_id":15368,"context":"check"},{"app_id":15368,"context":"pr-title"}],"contexts":["check","pr-title"],"strict":true}}',
  ) as Record<string, unknown>;

type RequestRecord = {
  readonly method: string;
  readonly path: string;
};

const applyWith = async (
  liveProtection: Readonly<Record<string, unknown>> | null,
  reportAction: (action: string) => void,
) =>
  applyDefaultBranchProtection({
    declared,
    live: {
      branch: 'trunk',
      classicProtection: liveProtection !== null,
      problem: null,
      protection: liveProtection,
      unverifiable: false,
    },
    reportAction,
    repo: 'owner/repo',
    token: 'token',
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('default branch apply final verification', () => {
  it('freshly verifies a stable default branch in exact request order', async () => {
    const calls: Array<RequestRecord> = [];
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? 'GET';
        calls.push({ method, path });
        if (method === 'PUT') {
          return Promise.resolve(response({}));
        }
        if (path === '/repos/owner/repo') {
          return Promise.resolve(
            response(JSON.parse('{"default_branch":"trunk"}')),
          );
        }
        if (path === '/repos/owner/repo/branches/trunk') {
          return Promise.resolve(
            response({
              name: 'trunk',
              protected: true,
              protection: { enabled: true },
            }),
          );
        }
        return Promise.resolve(response(protectionResponse()));
      },
      { preconnect: originalFetch.preconnect },
    );
    const actions: Array<string> = [];

    await applyWith(null, (action) => actions.push(action));

    expect(calls).toEqual([
      {
        method: 'PUT',
        path: '/repos/owner/repo/branches/trunk/protection',
      },
      { method: 'GET', path: '/repos/owner/repo' },
      { method: 'GET', path: '/repos/owner/repo/branches/trunk' },
      {
        method: 'GET',
        path: '/repos/owner/repo/branches/trunk/protection',
      },
    ]);
    expect(actions).toEqual([
      'updated classic protection for default branch "trunk"',
    ]);
  });

  it('fails after a concurrent default-branch rename without further writes', async () => {
    const calls: Array<RequestRecord> = [];
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ method, path: new URL(String(input)).pathname });
        return Promise.resolve(
          method === 'PUT'
            ? response({})
            : response(JSON.parse('{"default_branch":"renamed"}')),
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    const actions: Array<string> = [];

    await expect(
      applyWith(null, (action) => actions.push(action)),
    ).rejects.toThrow('changed from "trunk" to "renamed"');
    expect(calls).toEqual([
      {
        method: 'PUT',
        path: '/repos/owner/repo/branches/trunk/protection',
      },
      { method: 'GET', path: '/repos/owner/repo' },
    ]);
    expect(actions).toEqual([
      'updated classic protection for default branch "trunk"',
    ]);
  });

  it('rejects malformed repository readback before protection reads', async () => {
    const calls: Array<RequestRecord> = [];
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ method, path: new URL(String(input)).pathname });
        return Promise.resolve(
          method === 'PUT'
            ? response({})
            : response(JSON.parse('{"default_branch":7}')),
        );
      },
      { preconnect: originalFetch.preconnect },
    );

    await expect(applyWith(null, () => undefined)).rejects.toThrow(
      'invalid repository default branch',
    );
    expect(calls).toEqual([
      {
        method: 'PUT',
        path: '/repos/owner/repo/branches/trunk/protection',
      },
      { method: 'GET', path: '/repos/owner/repo' },
    ]);
  });

  it('performs no requests when the prefetched protection already converged', async () => {
    const calls: Array<RequestRecord> = [];
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? 'GET',
          path: new URL(String(input)).pathname,
        });
        return Promise.resolve(response({}));
      },
      { preconnect: originalFetch.preconnect },
    );

    await applyWith(declared, () => undefined);

    expect(calls).toEqual([]);
  });
});
