import { afterEach, expect, it } from 'bun:test';
import { type ApiCall, installApi } from './github-commands-test-support';
import { readReviewThread } from './poller-review-thread-api';
import {
  replyToReviewThread,
  resolveReviewThread,
} from './poller-review-thread-write';

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
    creation: { body: 'other', viewerDidAuthor: false },
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

it.each([
  ['null data', { data: null }],
  ['missing data', {}],
  [
    'wrong thread',
    {
      data: {
        resolveReviewThread: {
          thread: { id: 'PRRT_other', isResolved: true },
        },
      },
    },
  ],
  [
    'unresolved thread',
    {
      data: {
        resolveReviewThread: {
          thread: { id: 'PRRT_thread', isResolved: false },
        },
      },
    },
  ],
])('rejects a resolve mutation with %s', async (_, body) => {
  installApi([{ body }]);

  await expect(resolveReviewThread('token', 'PRRT_thread')).rejects.toThrow(
    'resolve review thread PRRT_thread',
  );
});
