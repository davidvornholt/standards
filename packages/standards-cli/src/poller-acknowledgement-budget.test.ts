import { afterEach, expect, it } from 'bun:test';
import { runPollerAcknowledgementTick } from './poller-acknowledgements';
import { issueRevision } from './poller-approval';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import { parsePollerConfig } from './poller-config';
import type { IssueItem } from './poller-github';
import { QUEUE_METADATA_MARKER } from './poller-protocol';
import { inspectQueuedAcknowledgement } from './poller-queue-marker';

const originalFetch = globalThis.fetch;
const REPOSITORY_COUNT = 12;
const API_REQUESTS_PER_HOUR = 5000;
const TICKS_PER_HOUR = 60;
const MAX_STEADY_REQUESTS_PER_HOUR = 3600;
const MINIMUM_REQUEST_HEADROOM = 1400;
const ISSUE_NUMBER = 7;
const APPROVED_AT = '2026-07-18T10:00:00Z';
const APPROVAL_EVENT_ID = 101;
const repos = Array.from(
  { length: REPOSITORY_COUNT },
  (_, index) => `owner/repo-${index + 1}`,
);

const issueItem = (): IssueItem => ({
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  isPullRequest: false,
  labels: ['approved-for-fix'],
  authorLogin: 'reporter',
});

const rawIssue = {
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  labels: [{ name: 'approved-for-fix' }],
  user: { login: 'reporter' },
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
      target: issueRevision(issueItem()),
    },
  }),
  user: { login: 'poller' },
  ...Object.fromEntries([['created_at', APPROVED_AT]]),
};

const labelEvent = {
  id: APPROVAL_EVENT_ID,
  event: 'labeled',
  label: { name: 'approved-for-fix' },
  actor: { login: 'maintainer' },
  ...Object.fromEntries([['created_at', APPROVED_AT]]),
};

const config = () => {
  const parsed = parsePollerConfig(
    {
      repos,
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

it('retains acknowledgement API headroom at the supported fleet shape', async () => {
  const calls: Array<string> = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    let body: unknown;
    if (url.pathname.endsWith('/issues')) {
      body =
        url.searchParams.get('labels') === 'approved-for-fix' ? [rawIssue] : [];
    } else if (url.pathname.endsWith('/comments')) {
      body = [queueComment];
    } else if (url.pathname.includes('/collaborators/')) {
      body = Object.fromEntries([['role_name', 'admin']]);
    } else if (url.pathname.endsWith('/timeline')) {
      body = [labelEvent];
    } else {
      return Promise.reject(
        new Error(`unexpected GitHub API request: ${url.pathname}`),
      );
    }
    return Promise.resolve(Response.json(body));
  }) as typeof fetch;

  const first = await runPollerAcknowledgementTick(config(), 'test-token');
  const second = await runPollerAcknowledgementTick(config(), 'test-token');
  expect(first).toEqual({ lines: [], problems: [] });
  expect(second).toEqual({ lines: [], problems: [] });

  const hourlyRequests = (calls.length / 2) * TICKS_PER_HOUR;
  expect(hourlyRequests).toBeLessThanOrEqual(MAX_STEADY_REQUESTS_PER_HOUR);
  expect(API_REQUESTS_PER_HOUR - hourlyRequests).toBeGreaterThanOrEqual(
    MINIMUM_REQUEST_HEADROOM,
  );
});

it('does not let an old marker hide a new approval generation', async () => {
  let requestIndex = 0;
  const bodies = [
    [queueComment],
    Object.fromEntries([['role_name', 'admin']]),
    [{ ...labelEvent, id: APPROVAL_EVENT_ID + 1 }],
  ];
  globalThis.fetch = (() => {
    const body = bodies[requestIndex];
    requestIndex += 1;
    return Promise.resolve(Response.json(body));
  }) as unknown as typeof fetch;
  expect(
    await inspectQueuedAcknowledgement({
      deps: {
        config: config(),
        token: 'test-token',
        repo: repos[0] ?? '',
        roleCache: new Map(),
      },
      item: issueItem(),
      kind: 'fix',
      target: issueRevision(issueItem()),
      blocksShortcut: () => false,
    }),
  ).toBe(false);
});
