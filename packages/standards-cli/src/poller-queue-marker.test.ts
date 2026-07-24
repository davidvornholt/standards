import { afterEach, expect, it } from 'bun:test';
import { issueRevision } from './poller-approval';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import type { PollerConfig } from './poller-config';
import type { IssueItem } from './poller-github';
import { QUEUE_METADATA_MARKER } from './poller-protocol';
import { inspectQueuedAcknowledgement } from './poller-queue-marker';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const APPROVED_AT = '2026-07-18T10:00:00Z';
const APPROVAL_EVENT_ID = 101;
const item: IssueItem = {
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  isPullRequest: false,
  labels: ['approved-for-fix'],
  authorLogin: 'reporter',
};
const queueComment = {
  id: 500,
  body: hiddenCommentMetadata(QUEUE_METADATA_MARKER, {
    approvalId: 'approval',
    kind: 'fix',
    approval: {
      actorLogin: 'maintainer',
      approvedAt: APPROVED_AT,
      eventId: APPROVAL_EVENT_ID,
      target: issueRevision(item),
    },
  }),
  user: { login: 'poller' },
  ...Object.fromEntries([['created_at', APPROVED_AT]]),
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('does not let an old marker hide a new approval generation', async () => {
  let requestIndex = 0;
  const bodies = [
    [queueComment],
    Object.fromEntries([['role_name', 'admin']]),
    [
      {
        id: APPROVAL_EVENT_ID + 1,
        event: 'labeled',
        label: { name: 'approved-for-fix' },
        actor: { login: 'maintainer' },
        ...Object.fromEntries([['created_at', APPROVED_AT]]),
      },
    ],
  ];
  globalThis.fetch = (() => {
    const body = bodies[requestIndex];
    requestIndex += 1;
    return Promise.resolve(Response.json(body));
  }) as unknown as typeof fetch;
  expect(
    await inspectQueuedAcknowledgement({
      deps: {
        config: {} as PollerConfig,
        token: 'test-token',
        repo: REPO,
        roleCache: new Map(),
      },
      item,
      kind: 'fix',
      target: issueRevision(item),
      blocksShortcut: () => false,
    }),
  ).toBe(false);
});
