import { afterEach, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { prRevision } from './poller-approval';
import { installPollerApiWithCommentDeletes } from './poller-comment-delete-test-support';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import { parsePollerConfig } from './poller-config';
import type { IssueItem } from './poller-github';
import {
  checkout,
  createLocalPollerRepo,
  createTestApproval,
  pushRef,
} from './poller-job-run-test-support';
import { QUEUE_METADATA_MARKER } from './poller-protocol';
import { queueMarkerFor } from './poller-queue-marker';
import {
  type ReviewPublicationPlan,
  reviewOutputBranch,
  sealReviewPlan,
} from './poller-review-output';
import { runReviewJob } from './poller-review-run';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const EARLIEST_MARKER_ID = 10;
const DUPLICATE_MARKER_ID = 11;
const roots: Array<string> = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it('reconciles existing review queue markers before starting', async () => {
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
  const queueComment = (id: number) => ({
    id,
    body: hiddenCommentMetadata(
      QUEUE_METADATA_MARKER,
      queueMarkerFor(binding, 'review'),
    ),
    user: { login: 'poller' },
    ...Object.fromEntries([['created_at', '2026-07-18T10:00:01Z']]),
  });
  const { deletedCommentIds } = installPollerApiWithCommentDeletes({
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    isPullRequest: true,
    initialComments: [
      queueComment(EARLIEST_MARKER_ID),
      queueComment(DUPLICATE_MARKER_ID),
    ],
  });
  const parsed = parsePollerConfig(
    {
      repos: [REPO],
      model: 'gpt-test',
      reasoningEffort: 'high',
      cacheDir: fixture.cacheDir,
    },
    '/tmp',
  );
  if (parsed.config === null) {
    throw new Error('test config must parse');
  }
  await runReviewJob(
    {
      config: parsed.config,
      token: 'token',
      repo: REPO,
      roleCache: new Map(),
    },
    item,
    true,
  );
  expect(deletedCommentIds).toEqual([DUPLICATE_MARKER_ID]);
});
