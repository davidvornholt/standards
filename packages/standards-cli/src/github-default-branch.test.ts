import { afterEach, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fetchDefaultBranchProtection } from './github-default-branch';
import { applyDefaultBranchProtection } from './github-default-branch-apply';
import {
  decodeBranchSummary,
  decodeDefaultBranchProtection,
} from './github-default-branch-response';

const originalFetch = globalThis.fetch;
const declared = JSON.parse(
  await readFile(
    new URL('../../../.github/settings.json', import.meta.url),
    'utf8',
  ),
).default_branch_protection as Record<string, unknown>;
const HTTP_FORBIDDEN = 403;
const HTTP_OK = 200;
const repository = JSON.parse('{"default_branch":"trunk"}') as Record<
  string,
  unknown
>;

const response = (status: number, body: unknown = null): Response =>
  new Response(body === null ? null : JSON.stringify(body), { status });

const liveProtection = (): Record<string, unknown> =>
  JSON.parse(
    '{"allow_deletions":{"enabled":false},"allow_force_pushes":{"enabled":false},"block_creations":{"enabled":false},"enforce_admins":{"enabled":true},"required_conversation_resolution":{"enabled":true},"required_linear_history":{"enabled":true},"required_pull_request_reviews":{"dismiss_stale_reviews":true,"require_code_owner_reviews":false,"require_last_push_approval":false,"required_approving_review_count":0},"required_status_checks":{"checks":[{"app_id":15368,"context":"check"},{"app_id":15368,"context":"pr-title"}],"contexts":["check","pr-title"],"strict":true}}',
  ) as Record<string, unknown>;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('default branch protection responses', () => {
  it('distinguishes a ruleset-only protected branch from classic protection', () => {
    expect(
      decodeBranchSummary(
        { name: 'trunk', protected: true, protection: { enabled: false } },
        'trunk',
      ).value,
    ).toBe(false);
  });

  it('normalizes server wrappers and omitted empty actor collections', () => {
    expect(decodeDefaultBranchProtection(liveProtection()).value).toEqual(
      declared,
    );
  });

  it('marks forbidden details unverifiable only after classic existence is proven', async () => {
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo) =>
        Promise.resolve(
          String(input).endsWith('/protection')
            ? response(HTTP_FORBIDDEN, { message: 'forbidden' })
            : response(HTTP_OK, {
                name: 'trunk',
                protected: true,
                protection: { enabled: true },
              }),
        ),
      { preconnect: originalFetch.preconnect },
    );
    const check = await fetchDefaultBranchProtection(
      'token',
      'owner/repo',
      repository,
      false,
    );
    expect(check).toMatchObject({
      classicProtection: true,
      unverifiable: true,
    });
    expect(
      (
        await fetchDefaultBranchProtection(
          'token',
          'owner/repo',
          repository,
          true,
        )
      ).problem,
    ).toContain('HTTP 403');
  });
});

describe('default branch protection apply', () => {
  it('creates protection, reports immediately, and verifies normalized readback', async () => {
    const calls: Array<{ body: string | null; method: string }> = [];
    globalThis.fetch = Object.assign(
      (_input: URL | RequestInfo, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({
          body: typeof init?.body === 'string' ? init.body : null,
          method,
        });
        if (method === 'PUT') {
          return Promise.resolve(response(HTTP_OK, {}));
        }
        return Promise.resolve(
          calls.filter((call) => call.method === 'GET').length === 1
            ? response(HTTP_OK, {
                name: 'trunk',
                protected: true,
                protection: { enabled: true },
              })
            : response(HTTP_OK, liveProtection()),
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    const actions: Array<string> = [];
    await applyDefaultBranchProtection({
      declared,
      live: {
        branch: 'trunk',
        classicProtection: false,
        problem: null,
        protection: null,
        unverifiable: false,
      },
      reportAction: (action) => actions.push(action),
      repo: 'owner/repo',
      token: 'token',
    });
    expect(actions).toEqual([
      'updated classic protection for default branch "trunk"',
    ]);
    const putBody = JSON.parse(
      calls.find((call) => call.method === 'PUT')?.body ?? '{}',
    ) as Record<string, unknown>;
    expect(putBody.required_status_checks).toEqual(
      declared.required_status_checks,
    );
    expect(putBody.required_status_checks).not.toHaveProperty('contexts');
  });
});
