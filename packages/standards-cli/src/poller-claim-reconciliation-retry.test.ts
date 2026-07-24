import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { HTTP_CREATED, HTTP_NO_CONTENT } from './github-api';
import { type ApiCall, installApi } from './github-commands-test-support';
import type { ApprovalBinding } from './poller-approval';
import { acquireClaim, validateClaim } from './poller-claim';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import { CLAIM_METADATA_MARKER } from './poller-protocol';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const APPROVED_AT = '2026-07-18T11:00:00Z';
const CLAIMED_AT = '2026-07-18T12:00:00Z';
const APPROVAL_EVENT_ID = 100;
const CLAIM_EVENT_ID = 101;
const EARLIEST_MARKER_ID = 10;
const DUPLICATE_MARKER_ID = 11;
const NEW_MARKER_ID = 12;
const approvalFields = {
  repo: REPO,
  issueNumber: ISSUE_NUMBER,
  eventId: APPROVAL_EVENT_ID,
  label: 'approved-for-fix',
  actorLogin: 'maintainer',
  approvedAt: APPROVED_AT,
  target: 'issue:revision',
};
const approval: ApprovalBinding = {
  id: createHash('sha256').update(JSON.stringify(approvalFields)).digest('hex'),
  ...approvalFields,
};
const context = {
  token: 'token',
  repo: REPO,
  issueNumber: ISSUE_NUMBER,
};
const rawIssue = {
  number: ISSUE_NUMBER,
  title: 'Title',
  body: 'Body',
  labels: [{ name: 'approved-for-fix' }, { name: 'fix-in-progress' }],
  user: { login: 'reporter' },
};
const labelEvent = (id: number, label: string, createdAt: string) => ({
  id,
  event: 'labeled',
  label: { name: label },
  actor: { login: 'maintainer' },
  ...Object.fromEntries([['created_at', createdAt]]),
});
const marker = (id: number, epoch = String(CLAIM_EVENT_ID)) => ({
  id,
  body: hiddenCommentMetadata(CLAIM_METADATA_MARKER, {
    approval,
    claimLabel: 'fix-in-progress',
    claimEpoch: epoch,
    nonce: `nonce-${id}`,
  }),
  user: { login: 'poller' },
  ...Object.fromEntries([['created_at', CLAIMED_AT]]),
});
const role = {
  body: Object.fromEntries([['role_name', 'maintain']]),
};
const deletedIds = (calls: ReadonlyArray<ApiCall>) =>
  calls
    .filter(({ method }) => method === 'DELETE')
    .map(({ path }) => Number(path.split('/').at(-1)));

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('retries a failed loser cleanup when the winner validates', async () => {
  installApi([
    {
      body: [labelEvent(CLAIM_EVENT_ID, 'fix-in-progress', CLAIMED_AT)],
    },
    { status: HTTP_CREATED, body: { id: DUPLICATE_MARKER_ID } },
    {
      body: [marker(EARLIEST_MARKER_ID), marker(DUPLICATE_MARKER_ID)],
    },
    role,
    role,
    { status: 500, body: { message: 'transient failure' } },
  ]);
  await expect(
    acquireClaim(context, approval, 'fix-in-progress'),
  ).rejects.toThrow('delete comment 11');

  const retryCalls = installApi([
    { body: rawIssue },
    {
      body: [labelEvent(APPROVAL_EVENT_ID, 'approved-for-fix', APPROVED_AT)],
    },
    role,
    { body: rawIssue },
    {
      body: [marker(EARLIEST_MARKER_ID), marker(DUPLICATE_MARKER_ID)],
    },
    role,
    role,
    { status: HTTP_NO_CONTENT, body: null },
  ]);
  await expect(
    validateClaim(
      context,
      {
        approval,
        claimLabel: 'fix-in-progress',
        claimEpoch: String(CLAIM_EVENT_ID),
        markerId: EARLIEST_MARKER_ID,
      },
      approval.target,
    ),
  ).resolves.toBeNull();
  expect(deletedIds(retryCalls)).toEqual([DUPLICATE_MARKER_ID]);
});

it('deletes a newly posted claim marker omitted from its election listing', async () => {
  const calls = installApi([
    {
      body: [labelEvent(CLAIM_EVENT_ID, 'fix-in-progress', CLAIMED_AT)],
    },
    { status: HTTP_CREATED, body: { id: NEW_MARKER_ID } },
    { body: [marker(EARLIEST_MARKER_ID)] },
    role,
    { status: HTTP_NO_CONTENT, body: null },
  ]);
  await expect(
    acquireClaim(context, approval, 'fix-in-progress'),
  ).resolves.toBeNull();
  expect(deletedIds(calls)).toEqual([NEW_MARKER_ID]);
});
