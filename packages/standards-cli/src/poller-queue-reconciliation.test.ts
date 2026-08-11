import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { HTTP_CREATED, HTTP_NO_CONTENT } from './github-api';
import { type ApiCall, installApi } from './github-commands-test-support';
import { runPollerAcknowledgementTick } from './poller-acknowledgements';
import {
  type ApprovalBinding,
  issueRevision,
  prRevision,
} from './poller-approval';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import type { PollerConfig } from './poller-config';
import {
  APPROVED_FOR_FIX,
  APPROVED_FOR_REVIEW,
  QUEUE_METADATA_MARKER,
} from './poller-protocol';
import type { PollerJobKind } from './poller-queue-marker';
import { acknowledgeQueuedJob } from './poller-status';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const APPROVED_AT = '2026-07-18T10:00:00Z';
const APPROVAL_EVENT_ID = 101;
const BASE_SHA = 'base';
const HEAD_SHA = 'head';
const EARLIEST_MARKER_ID = 10;
const DUPLICATE_MARKER_ID = 11;
const NEW_MARKER_ID = 12;

const approvalLabel = (kind: PollerJobKind) =>
  kind === 'fix' ? APPROVED_FOR_FIX : APPROVED_FOR_REVIEW;
const rawIssue = (kind: PollerJobKind) => ({
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  labels: [{ name: approvalLabel(kind) }],
  user: { login: 'reporter' },
  ...(kind === 'review'
    ? Object.fromEntries([['pull_request', { url: 'x' }]])
    : {}),
});
const target = (kind: PollerJobKind) =>
  kind === 'fix'
    ? issueRevision({
        number: ISSUE_NUMBER,
        title: 'Title',
        body: 'Body',
        isPullRequest: false,
        labels: [APPROVED_FOR_FIX],
        authorLogin: 'reporter',
      })
    : prRevision('main', BASE_SHA, HEAD_SHA);
const approval = (kind: PollerJobKind): ApprovalBinding => {
  const fields = {
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    eventId: APPROVAL_EVENT_ID,
    label: approvalLabel(kind),
    actorLogin: 'maintainer',
    approvedAt: APPROVED_AT,
    target: target(kind),
  };
  return {
    id: createHash('sha256').update(JSON.stringify(fields)).digest('hex'),
    ...fields,
  };
};
const marker = (kind: PollerJobKind, id: number) => ({
  id,
  body: hiddenCommentMetadata(QUEUE_METADATA_MARKER, {
    approvalId: approval(kind).id,
    kind,
    approval: {
      actorLogin: 'maintainer',
      approvedAt: APPROVED_AT,
      eventId: APPROVAL_EVENT_ID,
      target: target(kind),
    },
  }),
  user: { login: 'poller' },
  ...Object.fromEntries([['created_at', APPROVED_AT]]),
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
const timeline = (kind: PollerJobKind) => [
  {
    id: APPROVAL_EVENT_ID,
    event: 'labeled',
    label: { name: approvalLabel(kind) },
    actor: { login: 'maintainer' },
    ...Object.fromEntries([['created_at', APPROVED_AT]]),
  },
];
const role = (name: string) => ({
  body: Object.fromEntries([['role_name', name]]),
});
const listResponses = (kind: PollerJobKind) =>
  kind === 'review'
    ? [{ body: [rawIssue(kind)] }, { body: [] }]
    : [{ body: [] }, { body: [rawIssue(kind)] }];
const config = { repos: [REPO] } as unknown as PollerConfig;
const deletedIds = (calls: ReadonlyArray<ApiCall>) =>
  calls
    .filter(({ method }) => method === 'DELETE')
    .map(({ path }) => Number(path.split('/').at(-1)));

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it.each(['fix', 'review'] as const)(
  'reconciles current duplicate %s acknowledgements through the full tick',
  async (kind) => {
    const issue = rawIssue(kind);
    const duplicates = [
      marker(kind, EARLIEST_MARKER_ID),
      marker(kind, DUPLICATE_MARKER_ID),
    ];
    const calls = installApi([
      ...listResponses(kind),
      ...(kind === 'review' ? [{ body: pullRequest }] : []),
      { body: duplicates },
      role('maintain'),
      { body: timeline(kind) },
      ...(kind === 'review' ? [{ body: [] }] : []),
      { body: issue },
      { body: timeline(kind) },
      role('maintain'),
      { body: issue },
      { body: duplicates },
      { status: HTTP_NO_CONTENT, body: null },
    ]);

    await expect(
      runPollerAcknowledgementTick(config, 'token'),
    ).resolves.toEqual({
      lines: [],
      problems: [],
    });
    expect(deletedIds(calls)).toEqual([DUPLICATE_MARKER_ID]);

    const secondPass = installApi([
      ...listResponses(kind),
      ...(kind === 'review' ? [{ body: pullRequest }] : []),
      { body: [marker(kind, EARLIEST_MARKER_ID)] },
      role('maintain'),
      { body: timeline(kind) },
    ]);
    await expect(
      runPollerAcknowledgementTick(config, 'token'),
    ).resolves.toEqual({
      lines: [],
      problems: [],
    });
    expect(secondPass.every(({ method }) => method === 'GET')).toBe(true);
  },
);

it.each(['fix', 'review'] as const)(
  'deletes a newly posted %s marker omitted from its election listing',
  async (kind) => {
    const binding = approval(kind);
    const calls = installApi([
      { body: rawIssue(kind) },
      { body: [] },
      { status: HTTP_CREATED, body: { id: NEW_MARKER_ID } },
      { body: [marker(kind, EARLIEST_MARKER_ID)] },
      role('maintain'),
      { status: HTTP_NO_CONTENT, body: null },
    ]);
    await expect(
      acknowledgeQueuedJob(
        {
          config,
          token: 'token',
          repo: REPO,
          roleCache: new Map(),
        },
        ISSUE_NUMBER,
        binding,
        kind,
      ),
    ).resolves.toBe(false);
    expect(deletedIds(calls)).toEqual([NEW_MARKER_ID]);
  },
);
