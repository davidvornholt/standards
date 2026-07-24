import { afterEach, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { issueRevision } from './poller-approval';
import {
  installPollerApiWithCommentDeletes,
  installPollerApiWithFailingCommentDelete,
} from './poller-comment-delete-test-support';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import { parsePollerConfig } from './poller-config';
import { sealFixOutput } from './poller-fix-output';
import { runFixJob } from './poller-fix-run';
import type { IssueItem } from './poller-github';
import {
  checkout,
  commitFile,
  createLocalPollerRepo,
  createTestApproval,
  pushRef,
} from './poller-job-run-test-support';
import {
  branchNameForIssue,
  CLAIM_METADATA_MARKER,
  QUEUE_METADATA_MARKER,
} from './poller-protocol';
import { queueMarkerFor } from './poller-queue-marker';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const EARLIEST_MARKER_ID = 10;
const DUPLICATE_MARKER_ID = 11;
const OLD_CLAIM_WINNER_ID = 20;
const OLD_CLAIM_DUPLICATE_ID = 21;
const roots: Array<string> = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it('reconciles existing fix queue markers before starting', async () => {
  const fixture = createLocalPollerRepo();
  roots.push(fixture.root);
  const item: IssueItem = {
    number: ISSUE_NUMBER,
    title: 'Title',
    body: 'Body',
    isPullRequest: false,
    labels: ['approved-for-fix'],
    authorLogin: 'reporter',
  };
  const binding = createTestApproval('approved-for-fix', issueRevision(item));
  checkout(fixture.source, fixture.baseSha);
  commitFile(fixture.source, 'fixed.txt', 'fixed\n');
  const sealed = sealFixOutput(fixture.source, {
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    approvalId: binding.id,
    title: 'fix(poller): recover output',
    body: 'Recovered.',
    baseSha: fixture.baseSha,
    commits: 1,
  });
  pushRef(
    fixture.source,
    branchNameForIssue(ISSUE_NUMBER, binding.id),
    sealed.sealedHead,
  );
  const queueComment = (id: number) => ({
    id,
    body: hiddenCommentMetadata(
      QUEUE_METADATA_MARKER,
      queueMarkerFor(binding, 'fix'),
    ),
    user: { login: 'poller' },
    ...Object.fromEntries([['created_at', '2026-07-18T10:00:01Z']]),
  });
  const { deletedCommentIds } = installPollerApiWithCommentDeletes({
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    isPullRequest: false,
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
  await runFixJob(
    {
      config: parsed.config,
      token: 'token',
      repo: REPO,
      roleCache: new Map(),
    },
    item,
    () => Promise.resolve('main'),
    true,
  );
  expect(deletedCommentIds).toEqual([DUPLICATE_MARKER_ID]);
});

it('leaves the job unclaimed when historical cleanup fails', async () => {
  const fixture = createLocalPollerRepo();
  roots.push(fixture.root);
  const item: IssueItem = {
    number: ISSUE_NUMBER,
    title: 'Title',
    body: 'Body',
    isPullRequest: false,
    labels: ['approved-for-fix'],
    authorLogin: 'reporter',
  };
  const binding = createTestApproval('approved-for-fix', issueRevision(item));
  const claimComment = (id: number) => ({
    id,
    body: hiddenCommentMetadata(CLAIM_METADATA_MARKER, {
      approval: binding,
      claimLabel: 'fix-in-progress',
      claimEpoch: 'ended-epoch',
      nonce: `nonce-${id}`,
    }),
    user: { login: 'poller' },
    ...Object.fromEntries([['created_at', '2026-07-18T10:00:01Z']]),
  });
  const { calls, deletedCommentIds } = installPollerApiWithFailingCommentDelete(
    {
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      isPullRequest: false,
      initialComments: [
        claimComment(OLD_CLAIM_WINNER_ID),
        claimComment(OLD_CLAIM_DUPLICATE_ID),
      ],
    },
  );
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
  await expect(
    runFixJob(
      {
        config: parsed.config,
        token: 'token',
        repo: REPO,
        roleCache: new Map(),
      },
      item,
      () => Promise.resolve('main'),
      true,
    ),
  ).rejects.toThrow(`delete comment ${OLD_CLAIM_DUPLICATE_ID}`);
  expect(deletedCommentIds).toEqual([OLD_CLAIM_DUPLICATE_ID]);
  expect(calls.every(({ method }) => method === 'GET')).toBe(true);
});
