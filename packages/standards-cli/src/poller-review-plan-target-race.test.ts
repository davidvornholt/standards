import { afterEach, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { installApi } from './github-commands-test-support';
import { prRevision } from './poller-approval';
import { parsePollerConfig } from './poller-config';
import type { IssueItem } from './poller-github';
import {
  createLocalPollerRepo,
  createTestApproval,
} from './poller-job-run-test-support';
import {
  type ReviewPublicationPlan,
  reviewPlanMarker,
} from './poller-review-output';
import { runReviewJob } from './poller-review-run';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const PUBLISHED_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MOVED_HEAD = 'cccccccccccccccccccccccccccccccccccccccc';
const roots: Array<string> = [];

const rawIssue = {
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  labels: [{ name: 'approved-for-review' }],
  user: { login: 'reporter' },
  ...Object.fromEntries([['pull_request', { url: 'x' }]]),
};

const event = {
  id: 101,
  event: 'labeled',
  label: { name: 'approved-for-review' },
  actor: { login: 'maintainer' },
  ...Object.fromEntries([['created_at', '2026-07-18T10:00:00Z']]),
};

const role = { body: Object.fromEntries([['role_name', 'admin']]) };

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

it('rejects a plan-present PR head outside its approved history', async () => {
  const fixture = createLocalPollerRepo();
  roots.push(fixture.root);
  const pullRequest = (headSha: string) => ({
    ...Object.fromEntries([['node_id', 'PR_node']]),
    title: 'Title',
    body: 'Body',
    draft: true,
    head: {
      ref: 'feature',
      sha: headSha,
      repo: Object.fromEntries([['full_name', REPO]]),
    },
    base: { ref: 'main', sha: fixture.baseSha },
  });
  const approval = createTestApproval(
    'approved-for-review',
    prRevision('main', fixture.baseSha, fixture.headSha),
  );
  const plan: ReviewPublicationPlan = {
    repo: REPO,
    prNumber: ISSUE_NUMBER,
    approvalId: approval.id,
    approvedHead: fixture.headSha,
    publishedHead: PUBLISHED_HEAD,
    baseRef: 'main',
    baseSha: fixture.baseSha,
    report: 'Reviewed.',
    commits: 1,
    threadsToResolve: [],
  };
  const planComment = {
    id: 1,
    body: reviewPlanMarker(plan),
    user: { login: 'maintainer' },
    ...Object.fromEntries([['created_at', '2026-07-18T11:00:00Z']]),
  };
  const calls = installApi([
    { body: rawIssue },
    { body: pullRequest(fixture.headSha) },
    { body: [planComment] },
    role,
    { body: rawIssue },
    { body: [event] },
    role,
    { body: rawIssue },
    { body: [event] },
    role,
    { body: [planComment] },
    { body: rawIssue },
    { body: [event] },
    role,
    { body: pullRequest(MOVED_HEAD) },
  ]);
  let agentCalls = 0;
  const item: IssueItem = {
    number: ISSUE_NUMBER,
    title: 'Title',
    body: 'Body',
    isPullRequest: true,
    labels: ['approved-for-review'],
    authorLogin: 'reporter',
  };

  const result = await runReviewJob(deps(fixture.cacheDir), item, true, () => {
    agentCalls += 1;
    throw new Error('agent must not run');
  });

  expect(result).toEqual({
    lines: [`PR #${ISSUE_NUMBER}: approval no longer present; skipped`],
    ranCodex: false,
  });
  expect(calls.every(({ method }) => method === 'GET')).toBe(true);
  expect(agentCalls).toBe(0);
});
