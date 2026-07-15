import { afterEach, expect, it } from 'bun:test';
import { HTTP_NO_CONTENT, HTTP_OK } from './github-api';
import {
  declaredDefaultBranchProtection,
  defaultBranchResponse,
} from './github-default-branch-test-fixture';
import { deleteVerifiedUndeclaredRuleset } from './github-ruleset-deletion';
import { declaredRuleset } from './github-ruleset-test-fixture';

const originalFetch = globalThis.fetch;
const RULESET_ID = 2;
const SOURCE_TYPE = 'source_type';

const ruleset = (name: string): Record<string, unknown> => ({
  ...declaredRuleset(name),
  id: RULESET_ID,
  source: 'owner/repo',
  [SOURCE_TYPE]: 'Repository',
  target: 'branch',
});

const response = (status: number, body: unknown = null): Response =>
  new Response(body === null ? null : JSON.stringify(body), { status });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('rechecks exact ruleset identity after the declaration and origin guard', async () => {
  const events: Array<string> = [];
  let liveName = 'Old';
  let deleteCount = 0;
  globalThis.fetch = Object.assign(
    (requestInput: URL | RequestInfo, init?: RequestInit) => {
      const path = new URL(String(requestInput)).pathname;
      const method = init?.method ?? 'GET';
      events.push(`${method} ${path}`);
      if (method === 'DELETE') {
        deleteCount += 1;
        return Promise.resolve(response(HTTP_NO_CONTENT));
      }
      return Promise.resolve(
        response(HTTP_OK, defaultBranchResponse(path) ?? ruleset(liveName)),
      );
    },
    { preconnect: originalFetch.preconnect },
  );

  await expect(
    deleteVerifiedUndeclaredRuleset({
      beforeMutation: () => {
        events.push('declaration and origin guard');
        liveName = 'Canonical';
        return Promise.resolve();
      },
      declaredNames: new Set(['Canonical']),
      defaultBranchProtection: declaredDefaultBranchProtection,
      liveRuleset: ruleset('Old'),
      name: 'Old',
      repo: 'owner/repo',
      token: 'token',
    }),
  ).rejects.toThrow('changed identity or declaration status before deletion');
  expect(deleteCount).toBe(0);
  expect(events).toEqual([
    'declaration and origin guard',
    'GET /repos/owner/repo',
    'GET /repos/owner/repo/branches/trunk',
    'GET /repos/owner/repo/branches/trunk/protection',
    'GET /repos/owner/repo',
    `GET /repos/owner/repo/rulesets/${RULESET_ID}`,
  ]);
});
