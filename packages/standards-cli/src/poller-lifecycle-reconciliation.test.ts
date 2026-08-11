import { afterEach, expect, it } from 'bun:test';
import { HTTP_CREATED, HTTP_NO_CONTENT } from './github-api';
import { type ApiCall, installApi } from './github-commands-test-support';
import type { ApprovalBinding } from './poller-approval';
import { acquireClaim } from './poller-claim';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import type { PollerConfig } from './poller-config';
import {
  APPROVED_FOR_FIX,
  APPROVED_FOR_REVIEW,
  CLAIM_METADATA_MARKER,
  QUEUE_METADATA_MARKER,
} from './poller-protocol';
import type { PollerJobKind } from './poller-queue-marker';
import { acknowledgeQueuedJob } from './poller-status';

const originalFetch = globalThis.fetch;
const REPO = 'owner/repo';
const ISSUE_NUMBER = 7;
const EARLIEST_MARKER_ID = 10;
const DUPLICATE_MARKER_ID = 11;
const NEW_MARKER_ID = 12;
const approval = (kind: PollerJobKind): ApprovalBinding => ({
  id: `${kind}-approval`,
  repo: REPO,
  issueNumber: ISSUE_NUMBER,
  eventId: 100,
  label: kind === 'fix' ? APPROVED_FOR_FIX : APPROVED_FOR_REVIEW,
  actorLogin: 'maintainer',
  approvedAt: '2026-07-18T11:00:00Z',
  target: `${kind}:target`,
});
const comment = (id: number, body: string) => ({
  id,
  body,
  user: { login: 'poller' },
  ...Object.fromEntries([['created_at', '2026-07-18T12:00:01Z']]),
});
const trustedRole = {
  body: Object.fromEntries([['role_name', 'maintain']]),
};
const deletedCommentIds = (calls: ReadonlyArray<ApiCall>) =>
  calls
    .filter(({ method }) => method === 'DELETE')
    .map(({ path }) => Number(path.split('/').at(-1)));

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it.each(['fix', 'review'] as const)(
  'reconciles trusted duplicate %s queue markers left by a failed delete',
  async (kind) => {
    const binding = approval(kind);
    const markerBody = hiddenCommentMetadata(QUEUE_METADATA_MARKER, {
      approvalId: binding.id,
      kind,
    });
    const calls = installApi([
      {
        body: {
          number: ISSUE_NUMBER,
          title: 'Title',
          body: 'Body',
          labels: [{ name: binding.label }],
          user: { login: 'reporter' },
        },
      },
      {
        body: [
          comment(DUPLICATE_MARKER_ID, markerBody),
          comment(EARLIEST_MARKER_ID, markerBody),
        ],
      },
      trustedRole,
      { status: HTTP_NO_CONTENT, body: null },
    ]);

    await expect(
      acknowledgeQueuedJob(
        {
          config: {} as PollerConfig,
          token: 'token',
          repo: REPO,
          roleCache: new Map(),
        },
        ISSUE_NUMBER,
        binding,
        kind,
      ),
    ).resolves.toBe(false);
    expect(deletedCommentIds(calls)).toEqual([DUPLICATE_MARKER_ID]);
    expect(calls.some(({ method }) => method === 'POST')).toBe(false);
  },
);

it('reconciles every trusted duplicate claim marker left by a failed delete', async () => {
  const binding = approval('fix');
  const claim = {
    approval: binding,
    claimLabel: 'fix-in-progress',
    claimEpoch: '101',
  };
  const marker = (id: number) =>
    comment(
      id,
      hiddenCommentMetadata(CLAIM_METADATA_MARKER, {
        ...claim,
        nonce: `nonce-${id}`,
      }),
    );
  const calls = installApi([
    {
      body: [
        {
          id: 101,
          event: 'labeled',
          label: { name: claim.claimLabel },
          actor: { login: 'maintainer' },
          ...Object.fromEntries([['created_at', '2026-07-18T12:00:00Z']]),
        },
      ],
    },
    { status: HTTP_CREATED, body: { id: NEW_MARKER_ID } },
    {
      body: [
        marker(DUPLICATE_MARKER_ID),
        marker(EARLIEST_MARKER_ID),
        marker(NEW_MARKER_ID),
      ],
    },
    trustedRole,
    trustedRole,
    trustedRole,
    { status: HTTP_NO_CONTENT, body: null },
    { status: HTTP_NO_CONTENT, body: null },
  ]);

  await expect(
    acquireClaim(
      { token: 'token', repo: REPO, issueNumber: ISSUE_NUMBER },
      binding,
      claim.claimLabel,
    ),
  ).resolves.toBeNull();
  expect(deletedCommentIds(calls)).toEqual([
    DUPLICATE_MARKER_ID,
    NEW_MARKER_ID,
  ]);
});
