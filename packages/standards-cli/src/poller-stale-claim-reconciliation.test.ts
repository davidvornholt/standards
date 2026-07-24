import { afterEach, expect, it } from 'bun:test';
import { HTTP_CREATED, HTTP_NO_CONTENT, HTTP_OK } from './github-api';
import { type ApiCall, installApi } from './github-commands-test-support';
import type { ApprovalBinding } from './poller-approval';
import { acquireClaim } from './poller-claim';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import type { PollerConfig } from './poller-config';
import {
  APPROVED_FOR_FIX,
  CLAIM_METADATA_MARKER,
  FIX_IN_PROGRESS,
} from './poller-protocol';
import { discoverRepositoryJobs } from './poller-schedule';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const OLD_CLAIM_EVENT_ID = 101;
const NEW_CLAIM_EVENT_ID = 102;
const EARLIEST_MARKER_ID = 10;
const DUPLICATE_MARKER_ID = 11;
const NEW_MARKER_ID = 12;
const approval: ApprovalBinding = {
  id: 'approval',
  repo: REPO,
  issueNumber: ISSUE_NUMBER,
  eventId: 100,
  label: APPROVED_FOR_FIX,
  actorLogin: 'maintainer',
  approvedAt: '2026-07-18T10:00:00Z',
  target: 'issue:revision',
};
const issue = (labels: ReadonlyArray<string>) => ({
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  labels: labels.map((name) => ({ name })),
  user: { login: 'reporter' },
});
const labelEvent = (id: number, label: string) => ({
  id,
  event: 'labeled',
  label: { name: label },
  actor: { login: 'maintainer' },
  ...Object.fromEntries([['created_at', '2026-07-18T10:00:00Z']]),
});
const marker = (id: number, epoch: number) => ({
  id,
  body: hiddenCommentMetadata(CLAIM_METADATA_MARKER, {
    approval,
    claimLabel: FIX_IN_PROGRESS,
    claimEpoch: String(epoch),
    nonce: `nonce-${id}`,
  }),
  user: { login: 'poller' },
  ...Object.fromEntries([['created_at', '2026-07-18T10:00:01Z']]),
});
const role = {
  body: Object.fromEntries([['role_name', 'maintain']]),
};
const config = {
  staleClaimHours: 1,
} as PollerConfig;
const deps = {
  config,
  token: 'token',
  repo: REPO,
  roleCache: new Map(),
};
const deletedCommentIds = (calls: ReadonlyArray<ApiCall>) =>
  calls
    .filter(
      ({ method, path }) =>
        method === 'DELETE' && path.includes('/issues/comments/'),
    )
    .map(({ path }) => Number(path.split('/').at(-1)));

afterEach(() => {
  globalThis.fetch = originalFetch;
  deps.roleCache.clear();
});

it('reconciles a stale epoch before releasing it and preserves it in the next election', async () => {
  const staleCalls = installApi([
    { body: [issue([APPROVED_FOR_FIX, FIX_IN_PROGRESS])] },
    { body: [labelEvent(OLD_CLAIM_EVENT_ID, FIX_IN_PROGRESS)] },
    {
      body: [
        marker(EARLIEST_MARKER_ID, OLD_CLAIM_EVENT_ID),
        marker(DUPLICATE_MARKER_ID, OLD_CLAIM_EVENT_ID),
      ],
    },
    role,
    role,
    { status: HTTP_NO_CONTENT, body: null },
    { status: HTTP_OK, body: [] },
    { status: HTTP_CREATED, body: { id: 20 } },
    { body: [] },
    { body: [] },
    { body: [issue([APPROVED_FOR_FIX])] },
    { body: [labelEvent(approval.eventId, APPROVED_FOR_FIX)] },
  ]);
  const report = await discoverRepositoryJobs(
    deps,
    Date.parse('2026-07-18T12:00:01Z'),
  );
  expect(report.lines).toEqual([
    `${REPO}#${ISSUE_NUMBER}: released stale ${FIX_IN_PROGRESS}`,
  ]);
  expect(deletedCommentIds(staleCalls)).toEqual([DUPLICATE_MARKER_ID]);

  const nextElection = installApi([
    { body: [labelEvent(NEW_CLAIM_EVENT_ID, FIX_IN_PROGRESS)] },
    { status: HTTP_CREATED, body: { id: NEW_MARKER_ID } },
    {
      body: [
        marker(EARLIEST_MARKER_ID, OLD_CLAIM_EVENT_ID),
        marker(NEW_MARKER_ID, NEW_CLAIM_EVENT_ID),
      ],
    },
    role,
    role,
  ]);
  await expect(
    acquireClaim(
      { token: 'token', repo: REPO, issueNumber: ISSUE_NUMBER },
      approval,
      FIX_IN_PROGRESS,
    ),
  ).resolves.toMatchObject({ markerId: NEW_MARKER_ID });
  expect(deletedCommentIds(nextElection)).toEqual([]);
});

it('reconciles claim history before releasing a label with no usable event', async () => {
  const calls = installApi([
    { body: [issue([FIX_IN_PROGRESS])] },
    { body: [] },
    {
      body: [
        marker(EARLIEST_MARKER_ID, OLD_CLAIM_EVENT_ID),
        marker(DUPLICATE_MARKER_ID, OLD_CLAIM_EVENT_ID),
      ],
    },
    role,
    role,
    { status: HTTP_NO_CONTENT, body: null },
    { status: HTTP_OK, body: [] },
    { status: HTTP_CREATED, body: { id: 20 } },
    { body: [] },
    { body: [] },
    { body: [] },
  ]);
  const report = await discoverRepositoryJobs(
    deps,
    Date.parse('2026-07-18T12:00:01Z'),
  );
  expect(report.lines).toEqual([
    `${REPO}#${ISSUE_NUMBER}: released stale ${FIX_IN_PROGRESS}`,
  ]);
  expect(deletedCommentIds(calls)).toEqual([DUPLICATE_MARKER_ID]);
});
