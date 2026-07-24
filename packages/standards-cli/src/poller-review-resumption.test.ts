import { afterEach, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { installPollerApi } from './poller-api-test-support';
import { prRevision } from './poller-approval';
import { parsePollerConfig } from './poller-config';
import type { IssueItem } from './poller-github';
import {
  checkout,
  createLocalPollerRepo,
  createTestApproval,
  pushRef,
} from './poller-job-run-test-support';
import {
  type ReviewPublicationPlan,
  reviewOutputBranch,
  sealReviewPlan,
} from './poller-review-output';
import { runReviewJob } from './poller-review-run';
import { failGitHubRequestOnce } from './poller-transient-failure-test-support';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const roots: Array<string> = [];

const deps = (cacheDir: string) => {
  const parsed = parsePollerConfig(
    {
      repos: [REPO],
      model: 'gpt-test',
      reasoningEffort: 'high',
      cacheDir,
    },
    '/tmp',
  );
  if (parsed.config === null) {
    throw new Error('test config must parse');
  }
  return {
    config: parsed.config,
    token: 'token',
    repo: REPO,
    roleCache: new Map(),
  };
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it('continues a sealed review publication without Codex capacity', async () => {
  const fixture = createLocalPollerRepo();
  roots.push(fixture.root);
  const item: IssueItem = {
    number: ISSUE_NUMBER,
    title: 'Title',
    body: 'Body',
    isPullRequest: true,
    labels: ['approved-for-review'],
    authorLogin: 'reporter',
  };
  const binding = createTestApproval(
    'approved-for-review',
    prRevision('main', fixture.baseSha, fixture.headSha),
  );
  const plan: ReviewPublicationPlan = {
    repo: REPO,
    prNumber: ISSUE_NUMBER,
    approvalId: binding.id,
    approvedHead: fixture.headSha,
    publishedHead: fixture.headSha,
    baseRef: 'main',
    baseSha: fixture.baseSha,
    report: 'Reviewed.',
    commits: 0,
    threadsToResolve: [],
  };
  checkout(fixture.source, fixture.headSha);
  const sealedHead = sealReviewPlan(fixture.source, plan);
  pushRef(fixture.source, reviewOutputBranch(plan), sealedHead);
  const calls = installPollerApi({
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    isPullRequest: true,
  });
  const result = await runReviewJob(deps(fixture.cacheDir), item, false);
  expect(result).toEqual({
    lines: [`PR #${ISSUE_NUMBER}: reviewed (0 fix commit(s)), marked ready`],
    ranCodex: false,
  });
  expect(
    calls.some(
      (call) => call.method === 'POST' && call.path.endsWith('/reviews'),
    ),
  ).toBe(true);
  expect(
    calls.some(
      (call) =>
        call.method === 'POST' &&
        String(
          (call.body as { readonly body?: unknown } | null)?.body,
        ).startsWith('**Review queued**'),
    ),
  ).toBe(false);
});

it('releases a failed sealed review publication for the next tick', async () => {
  const fixture = createLocalPollerRepo();
  roots.push(fixture.root);
  const item: IssueItem = {
    number: ISSUE_NUMBER,
    title: 'Title',
    body: 'Body',
    isPullRequest: true,
    labels: ['approved-for-review'],
    authorLogin: 'reporter',
  };
  const binding = createTestApproval(
    'approved-for-review',
    prRevision('main', fixture.baseSha, fixture.headSha),
  );
  const plan: ReviewPublicationPlan = {
    repo: REPO,
    prNumber: ISSUE_NUMBER,
    approvalId: binding.id,
    approvedHead: fixture.headSha,
    publishedHead: fixture.headSha,
    baseRef: 'main',
    baseSha: fixture.baseSha,
    report: 'Reviewed.',
    commits: 0,
    threadsToResolve: [],
  };
  checkout(fixture.source, fixture.headSha);
  const sealedHead = sealReviewPlan(fixture.source, plan);
  pushRef(fixture.source, reviewOutputBranch(plan), sealedHead);
  const failedCalls = installPollerApi({
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    isPullRequest: true,
  });
  failGitHubRequestOnce('POST', '/graphql');

  await expect(
    runReviewJob(deps(fixture.cacheDir), item, false),
  ).rejects.toThrow('mark PR ready for review');
  expect(
    failedCalls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.path.endsWith('/labels/review-in-progress'),
    ),
  ).toBe(true);

  installPollerApi({
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    isPullRequest: true,
  });
  await expect(
    runReviewJob(deps(fixture.cacheDir), item, false),
  ).resolves.toEqual({
    lines: [`PR #${ISSUE_NUMBER}: reviewed (0 fix commit(s)), marked ready`],
    ranCodex: false,
  });
});
