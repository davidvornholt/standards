import { afterEach, expect, it } from 'bun:test';
import { type ApiCall, installApi } from './github-commands-test-support';
import {
  readReviewThread,
  replyToReviewThread,
  resolveReviewThread,
} from './poller-review-thread-api';

const originalFetch = globalThis.fetch;
const threadPage = (
  comments: ReadonlyArray<Readonly<Record<string, unknown>>>,
  hasNextPage: boolean,
) => ({
  body: {
    data: {
      node: {
        id: 'PRRT_thread',
        isResolved: false,
        pullRequest: {
          number: 4,
          repository: { nameWithOwner: 'owner/repo' },
        },
        comments: {
          nodes: comments,
          pageInfo: {
            hasNextPage,
            endCursor: hasNextPage ? 'next-page' : null,
          },
        },
      },
    },
  },
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('reads every thread-comment page for replay marker lookup', async () => {
  const calls = installApi([
    threadPage([{ body: 'other', viewerDidAuthor: false }], true),
    threadPage([{ body: 'mine', viewerDidAuthor: true }], false),
  ]);

  await expect(readReviewThread('token', 'PRRT_thread')).resolves.toEqual({
    id: 'PRRT_thread',
    repo: 'owner/repo',
    prNumber: 4,
    isResolved: false,
    viewerAuthoredBodies: ['mine'],
  });
  expect(calls.map((call) => call.body)).toEqual([
    expect.objectContaining({
      variables: { id: 'PRRT_thread', after: null },
    }),
    expect.objectContaining({
      variables: { id: 'PRRT_thread', after: 'next-page' },
    }),
  ]);
});

it('uses the review-thread reply and resolve mutations', async () => {
  const calls: ReadonlyArray<ApiCall> = installApi([
    {
      body: {
        data: {
          addPullRequestReviewThreadReply: {
            comment: { id: 'PRRC_reply' },
          },
        },
      },
    },
    {
      body: {
        data: {
          resolveReviewThread: {
            thread: { id: 'PRRT_thread', isResolved: true },
          },
        },
      },
    },
  ]);

  await replyToReviewThread('token', 'PRRT_thread', 'Verified.');
  await resolveReviewThread('token', 'PRRT_thread');

  expect(calls).toHaveLength(2);
  expect(calls[0]?.body).toEqual(
    expect.objectContaining({
      variables: {
        id: 'PRRT_thread',
        body: 'Verified.',
      },
    }),
  );
  expect(calls[1]?.body).toEqual(
    expect.objectContaining({ variables: { id: 'PRRT_thread' } }),
  );
});
