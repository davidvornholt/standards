import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { HTTP_CREATED } from './github-api';
import { type ApiCall, installApi } from './github-commands-test-support';
import { runPollerAcknowledgementTick } from './poller-acknowledgements';
import { issueRevision, prRevision } from './poller-approval';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import { parsePollerConfig } from './poller-config';
import { QUEUE_METADATA_MARKER } from './poller-protocol';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const BASE_SHA = 'base';
const HEAD_SHA = 'head';
const APPROVED_AT = '2026-07-18T10:00:00Z';
const APPROVAL_EVENT_ID = 101;
const COMMENT_ID = 500;

const rawIssue = (isPullRequest: boolean) => ({
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  labels: [
    { name: isPullRequest ? 'approved-for-review' : 'approved-for-fix' },
  ],
  user: { login: 'reporter' },
  ...(isPullRequest
    ? Object.fromEntries([['pull_request', { url: 'x' }]])
    : {}),
});

const pullRequest = {
  ...Object.fromEntries([['node_id', 'PR_node']]),
  title: 'Title',
  body: 'Body',
  draft: true,
  head: {
    ref: 'feature',
    sha: HEAD_SHA,
    repo: Object.fromEntries([['full_name', REPO]]),
  },
  base: { ref: 'main', sha: BASE_SHA },
};

const approvalId = (isPullRequest: boolean): string => {
  const fields = {
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    eventId: APPROVAL_EVENT_ID,
    label: isPullRequest ? 'approved-for-review' : 'approved-for-fix',
    actorLogin: 'maintainer',
    approvedAt: APPROVED_AT,
    target: isPullRequest
      ? prRevision('main', BASE_SHA, HEAD_SHA)
      : issueRevision({
          number: ISSUE_NUMBER,
          title: 'Title',
          body: 'Body',
          isPullRequest: false,
          labels: ['approved-for-fix'],
          authorLogin: 'reporter',
        }),
  };
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
};

const apiResponses = (
  isPullRequest: boolean,
): ReadonlyArray<{ readonly body: unknown; readonly status?: number }> => {
  const issue = rawIssue(isPullRequest);
  const approvalLabel = isPullRequest
    ? 'approved-for-review'
    : 'approved-for-fix';
  const listResponses = isPullRequest
    ? [{ body: [issue] }, { body: [] }]
    : [{ body: [] }, { body: [issue] }];
  return [
    ...listResponses,
    ...(isPullRequest ? [{ body: pullRequest }, { body: [] }] : []),
    { body: issue },
    {
      body: [
        {
          id: APPROVAL_EVENT_ID,
          event: 'labeled',
          label: { name: approvalLabel },
          actor: { login: 'maintainer' },
          ...Object.fromEntries([['created_at', APPROVED_AT]]),
        },
      ],
    },
    { body: Object.fromEntries([['role_name', 'admin']]) },
    { body: issue },
    { body: [] },
    { status: HTTP_CREATED, body: { id: COMMENT_ID } },
    {
      body: [
        {
          id: COMMENT_ID,
          body: hiddenCommentMetadata(QUEUE_METADATA_MARKER, {
            approvalId: approvalId(isPullRequest),
            kind: isPullRequest ? 'review' : 'fix',
          }),
          user: { login: 'poller' },
          ...Object.fromEntries([['created_at', APPROVED_AT]]),
        },
      ],
    },
    { body: Object.fromEntries([['role_name', 'admin']]) },
    { body: issue },
    ...(isPullRequest ? [{ body: pullRequest }] : []),
    { body: issue },
    {
      body: [
        {
          id: APPROVAL_EVENT_ID,
          event: 'labeled',
          label: { name: approvalLabel },
          actor: { login: 'maintainer' },
          ...Object.fromEntries([['created_at', APPROVED_AT]]),
        },
      ],
    },
    { body: Object.fromEntries([['role_name', 'admin']]) },
  ];
};

const config = () => {
  const parsed = parsePollerConfig(
    {
      repos: [REPO],
      model: 'gpt-test',
      reasoningEffort: 'high',
    },
    '/tmp',
  );
  if (parsed.config === null) {
    throw new Error('test config must parse');
  }
  return parsed.config;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it.each([
  ['fix', false, '**Fix queued**'],
  ['review', true, '**Review queued**'],
] as const)('acknowledges a queued %s without starting it', async (_kind, isPullRequest, heading) => {
  const calls: ReadonlyArray<ApiCall> = installApi(apiResponses(isPullRequest));
  const report = await runPollerAcknowledgementTick(config(), 'test-token');
  expect(report.problems).toEqual([]);
  expect(report.lines).toHaveLength(1);
  const comment = calls.find(
    (call) => call.method === 'POST' && call.path.endsWith('/comments'),
  );
  const body = (comment?.body as { readonly body?: unknown } | null)?.body;
  expect(body).toStartWith(heading);
  expect(body).toContain('You don’t need to do anything else.');
});
