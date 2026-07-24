import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { HTTP_CREATED, HTTP_NO_CONTENT } from './github-api';
import { installApi } from './github-commands-test-support';
import {
  type ApprovalBinding,
  issueRevision,
  prRevision,
} from './poller-approval';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import type { PollerConfig } from './poller-config';
import type { IssueItem } from './poller-github';
import {
  APPROVED_FOR_FIX,
  APPROVED_FOR_REVIEW,
  NEEDS_CLARIFICATION,
  QUEUE_METADATA_MARKER,
} from './poller-protocol';
import { acknowledgeQueuedJob, type PollerJobKind } from './poller-status';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const BASE_SHA = 'base';
const HEAD_SHA = 'head';
const APPROVED_AT = '2026-07-18T10:00:00Z';
const APPROVAL_EVENT_ID = 101;
const COMMENT_ID = 500;
const JOB_KINDS: Array<PollerJobKind> = ['fix', 'review'];

const approvalLabel = (kind: PollerJobKind) =>
  kind === 'fix' ? APPROVED_FOR_FIX : APPROVED_FOR_REVIEW;

const issue = (
  kind: PollerJobKind,
  labels: ReadonlyArray<string>,
  body = 'Body',
): IssueItem => ({
  number: ISSUE_NUMBER,
  title: 'Title',
  body,
  isPullRequest: kind === 'review',
  labels,
  authorLogin: 'reporter',
});

const rawIssue = (
  kind: PollerJobKind,
  labels: ReadonlyArray<string>,
  body = 'Body',
) => ({
  number: ISSUE_NUMBER,
  title: 'Title',
  body,
  labels: labels.map((name) => ({ name })),
  user: { login: 'reporter' },
  ...(kind === 'review'
    ? Object.fromEntries([['pull_request', { url: 'x' }]])
    : {}),
});

const pullRequest = (headSha = HEAD_SHA) => ({
  ...Object.fromEntries([['node_id', 'PR_node']]),
  head: {
    ref: 'feature',
    sha: headSha,
    repo: Object.fromEntries([['full_name', REPO]]),
  },
  base: { ref: 'main', sha: BASE_SHA },
});

const approval = (kind: PollerJobKind): ApprovalBinding => {
  const fields = {
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    eventId: APPROVAL_EVENT_ID,
    label: approvalLabel(kind),
    actorLogin: 'maintainer',
    approvedAt: APPROVED_AT,
    target:
      kind === 'fix'
        ? issueRevision(issue(kind, [approvalLabel(kind)]))
        : prRevision('main', BASE_SHA, HEAD_SHA),
  };
  return {
    id: createHash('sha256').update(JSON.stringify(fields)).digest('hex'),
    ...fields,
  };
};

const labelEvent = (kind: PollerJobKind, id = APPROVAL_EVENT_ID) => ({
  id,
  event: 'labeled',
  label: { name: approvalLabel(kind) },
  actor: { login: 'maintainer' },
  ...Object.fromEntries([['created_at', APPROVED_AT]]),
});

const markerComment = (kind: PollerJobKind) => ({
  id: COMMENT_ID,
  body: hiddenCommentMetadata(QUEUE_METADATA_MARKER, {
    approvalId: approval(kind).id,
    kind,
  }),
  user: { login: 'poller' },
  ...Object.fromEntries([['created_at', APPROVED_AT]]),
});

const beforePost = (kind: PollerJobKind) => [
  { body: rawIssue(kind, [approvalLabel(kind)]) },
  { body: [] },
  { status: HTTP_CREATED, body: { id: COMMENT_ID } },
  { body: [markerComment(kind)] },
  { body: Object.fromEntries([['role_name', 'admin']]) },
];

const deps = {
  config: {} as PollerConfig,
  token: 'token',
  repo: REPO,
  roleCache: new Map(),
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  deps.roleCache.clear();
});

const runRace = async (
  kind: PollerJobKind,
  responses: ReadonlyArray<{
    readonly body: unknown;
    readonly status?: number;
  }>,
) => {
  const calls = installApi([
    ...beforePost(kind),
    ...responses,
    { status: HTTP_NO_CONTENT, body: null },
  ]);
  const result = await acknowledgeQueuedJob(
    deps,
    ISSUE_NUMBER,
    approval(kind),
    kind,
  );
  return (
    result === false &&
    calls.at(-1)?.method === 'DELETE' &&
    calls.at(-1)?.path === `/repos/${REPO}/issues/comments/${COMMENT_ID}`
  );
};

it.each(
  JOB_KINDS,
)('deletes a race-late %s marker when completion removes approval', async (kind) => {
  expect(await runRace(kind, [{ body: rawIssue(kind, []) }])).toBe(true);
});

it.each(
  JOB_KINDS,
)('deletes a race-late %s marker when clarification starts', async (kind) => {
  expect(
    await runRace(kind, [
      {
        body: rawIssue(kind, [approvalLabel(kind), NEEDS_CLARIFICATION]),
      },
    ]),
  ).toBe(true);
});

it.each(
  JOB_KINDS,
)('deletes a race-late %s marker when the approval generation changes', async (kind) => {
  expect(
    await runRace(kind, [
      { body: rawIssue(kind, [approvalLabel(kind)]) },
      ...(kind === 'review' ? [{ body: pullRequest() }] : []),
      { body: rawIssue(kind, [approvalLabel(kind)]) },
      { body: [labelEvent(kind, APPROVAL_EVENT_ID + 1)] },
      { body: Object.fromEntries([['role_name', 'admin']]) },
    ]),
  ).toBe(true);
});

it.each(
  JOB_KINDS,
)('deletes a race-late %s marker when the approved target changes', async (kind) => {
  expect(
    await runRace(
      kind,
      kind === 'fix'
        ? [{ body: rawIssue(kind, [approvalLabel(kind)], 'Changed body') }]
        : [
            { body: rawIssue(kind, [approvalLabel(kind)]) },
            { body: pullRequest('changed-head') },
          ],
    ),
  ).toBe(true);
});
