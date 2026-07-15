import { afterEach, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fetchDefaultBranchProtection } from './github-default-branch';
import { applyDefaultBranchProtection } from './github-default-branch-apply';

const originalFetch = globalThis.fetch;
const DEFAULT_BRANCH_PROTECTION = 'default_branch_protection';
const REQUIRED_REVIEWS = 'required_pull_request_reviews';
const REQUIRED_CHECKS = 'required_status_checks';
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const declared = JSON.parse(
  await readFile(
    new URL('../../../.github/settings.json', import.meta.url),
    'utf8',
  ),
)[DEFAULT_BRANCH_PROTECTION] as Record<string, unknown>;
const repository = JSON.parse('{"default_branch":"trunk"}') as Record<
  string,
  unknown
>;

const response = (status: number, body: unknown = null): Response =>
  new Response(body === null ? null : JSON.stringify(body), { status });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const mockSummaryThenDetail = (
  classicProtection: boolean,
  detailStatus: number,
): void => {
  globalThis.fetch = Object.assign(
    (input: URL | RequestInfo) =>
      Promise.resolve(
        String(input).endsWith('/protection')
          ? response(detailStatus, { message: 'not found' })
          : response(HTTP_OK, {
              name: 'trunk',
              protected: classicProtection,
              protection: { enabled: classicProtection },
            }),
      ),
    { preconnect: originalFetch.preconnect },
  );
};

describe('classic protection detail 404', () => {
  it('is unverifiable in read-only mode after classic protection is proven', async () => {
    mockSummaryThenDetail(true, HTTP_NOT_FOUND);
    expect(
      await fetchDefaultBranchProtection(
        'token',
        'owner/repo',
        repository,
        false,
      ),
    ).toMatchObject({
      classicProtection: true,
      problem: null,
      unverifiable: true,
    });
  });

  it('fails closed in apply mode after classic protection is proven', async () => {
    mockSummaryThenDetail(true, HTTP_NOT_FOUND);
    expect(
      (
        await fetchDefaultBranchProtection(
          'token',
          'owner/repo',
          repository,
          true,
        )
      ).problem,
    ).toContain('HTTP 404');
  });

  it('remains valid create state when the summary proves no classic protection', async () => {
    mockSummaryThenDetail(false, HTTP_NOT_FOUND);
    expect(
      await fetchDefaultBranchProtection(
        'token',
        'owner/repo',
        repository,
        true,
      ),
    ).toMatchObject({
      classicProtection: false,
      problem: null,
      protection: null,
      unverifiable: false,
    });
  });
});

describe('disabled optional protection repair', () => {
  it('updates disabled sections and verifies the repaired response', async () => {
    const methods: Array<string> = [];
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        methods.push(method);
        if (method === 'PUT') {
          return Promise.resolve(response(HTTP_OK, {}));
        }
        if (String(input).endsWith('/repos/owner/repo')) {
          return Promise.resolve(
            response(HTTP_OK, JSON.parse('{"default_branch":"trunk"}')),
          );
        }
        return Promise.resolve(
          method === 'GET' && String(input).endsWith('/branches/trunk')
            ? response(HTTP_OK, {
                name: 'trunk',
                protected: true,
                protection: { enabled: true },
              })
            : response(HTTP_OK, {
                ...JSON.parse(
                  '{"allow_deletions":{"enabled":false},"allow_force_pushes":{"enabled":false},"allow_fork_syncing":{"enabled":false},"block_creations":{"enabled":false},"enforce_admins":{"enabled":true},"lock_branch":{"enabled":false},"required_conversation_resolution":{"enabled":true},"required_linear_history":{"enabled":true},"required_signatures":{"enabled":false}}',
                ),
                [REQUIRED_REVIEWS]: declared[REQUIRED_REVIEWS],
                [REQUIRED_CHECKS]: declared[REQUIRED_CHECKS],
              }),
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    const actions: Array<string> = [];
    await applyDefaultBranchProtection({
      declared,
      live: {
        branch: 'trunk',
        classicProtection: true,
        problem: null,
        protection: {
          ...declared,
          [REQUIRED_REVIEWS]: null,
          [REQUIRED_CHECKS]: null,
        },
        unverifiable: false,
      },
      reportAction: (action) => actions.push(action),
      repo: 'owner/repo',
      token: 'token',
    });
    expect(methods).toEqual(['GET', 'PUT', 'GET', 'GET', 'GET', 'GET']);
    expect(actions).toEqual([
      'updated classic protection for default branch "trunk"',
    ]);
  });
});
