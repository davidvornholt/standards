import { afterEach, expect, it } from 'bun:test';
import { installPollerApi } from './poller-api-test-support';
import { acquireClaim } from './poller-claim';

const originalFetch = globalThis.fetch;
const context = {
  token: 'token',
  repo: 'owner/repo',
  issueNumber: 7,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it.each([
  ['fix-in-progress', '**Fix started**', false],
  ['review-in-progress', '**Review started**', true],
] as const)('presents a natural start message and hides the %s claim metadata', async (claimLabel, heading, isPullRequest) => {
  const calls = installPollerApi({
    baseSha: 'base',
    headSha: 'head',
    isPullRequest,
  });
  const approval = {
    id: 'approval',
    repo: context.repo,
    issueNumber: context.issueNumber,
    eventId: 100,
    label: isPullRequest ? 'approved-for-review' : 'approved-for-fix',
    actorLogin: 'maintainer',
    approvedAt: '2026-07-18T11:00:00Z',
    target: isPullRequest ? 'pr:revision' : 'issue:revision',
  };
  expect(await acquireClaim(context, approval, claimLabel)).not.toBeNull();
  const comment = calls.find(
    (call) => call.method === 'POST' && call.path.endsWith('/comments'),
  );
  const body = (comment?.body as { readonly body?: unknown } | null)?.body;
  expect(typeof body).toBe('string');
  expect(body).toStartWith(heading);
  expect(body).toContain('<!-- standards-poller:claim\n');
  expect(String(body).split('<!--')[0]).not.toContain('"approval"');
});
