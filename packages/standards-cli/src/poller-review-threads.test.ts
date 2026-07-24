import { afterEach, expect, it } from 'bun:test';
import { type ApiCall, installApi } from './github-commands-test-support';
import {
  publishReviewThreadResolutions,
  threadResolutionMarker,
} from './poller-review-threads';
import {
  claim,
  deps,
  plan,
  pr,
  resolution,
  threadResponse,
  validationResponses,
} from './poller-review-threads-test-support';

const originalFetch = globalThis.fetch;
const SHA_LENGTH = 64;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

it('replies and resolves only after an immediate claim revalidation', async () => {
  const reply = `${resolution.verificationReply}\n\n${threadResolutionMarker(plan, resolution)}`;
  const calls: ReadonlyArray<ApiCall> = installApi([
    threadResponse(),
    ...validationResponses(),
    {
      body: {
        data: {
          addPullRequestReviewThreadReply: {
            comment: { id: 'PRRC_reply' },
          },
        },
      },
    },
    threadResponse({ body: reply }),
    ...validationResponses(),
    {
      body: {
        data: {
          resolveReviewThread: {
            thread: { id: resolution.threadId, isResolved: true },
          },
        },
      },
    },
    threadResponse({ body: reply, isResolved: true }),
  ]);

  await publishReviewThreadResolutions({ deps, pr, claim, plan });

  const mutations = calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => {
      const query =
        typeof call.body === 'object' &&
        call.body !== null &&
        'query' in call.body &&
        typeof call.body.query === 'string'
          ? call.body.query
          : '';
      return query.startsWith('mutation');
    });
  expect(mutations).toHaveLength(2);
  for (const mutation of mutations) {
    expect(calls[mutation.index - 1]?.path).toBe(
      '/repos/owner/repo/collaborators/poller/permission',
    );
  }
  expect(mutations[0]?.call.body).toEqual(
    expect.objectContaining({
      variables: { id: resolution.threadId, body: reply },
    }),
  );
});

it('replays a completed marker without writes', async () => {
  const reply = `${resolution.verificationReply}\n\n${threadResolutionMarker(plan, resolution)}`;
  const calls = installApi([
    threadResponse({ body: reply, isResolved: true }),
    threadResponse({ body: reply, isResolved: true }),
    threadResponse({ body: reply, isResolved: true }),
  ]);

  await publishReviewThreadResolutions({ deps, pr, claim, plan });

  expect(
    calls.filter((call) => {
      const body = call.body as { readonly query?: unknown } | null;
      return (
        typeof body?.query === 'string' && body.query.startsWith('mutation')
      );
    }),
  ).toEqual([]);
});

it('rejects an agent-supplied thread ID from another PR before writing', async () => {
  const calls = installApi([threadResponse({ prNumber: 99 })]);

  await expect(
    publishReviewThreadResolutions({ deps, pr, claim, plan }),
  ).rejects.toThrow(
    'publication blocked: review thread PRRT_thread belongs to owner/repo#99',
  );
  expect(calls).toHaveLength(1);
});

it.each([
  [
    'human-created',
    {
      creationViewerDidAuthor: false,
    },
  ],
  [
    'foreign',
    {
      creationBody: `Finding.\n\n<!-- standards-poller:review-thread approval=${'f'.repeat(SHA_LENGTH)} operation=${'a'.repeat(SHA_LENGTH)} -->`,
    },
  ],
] as const)('rejects a %s same-PR thread before writing', async (_, options) => {
  const calls = installApi([threadResponse(options)]);

  await expect(
    publishReviewThreadResolutions({ deps, pr, claim, plan }),
  ).rejects.toThrow(
    'publication blocked: review thread PRRT_thread was not created by this approval generation',
  );
  expect(calls).toHaveLength(1);
});

it('blocks publication when resolution readback remains unresolved', async () => {
  const reply = `${resolution.verificationReply}\n\n${threadResolutionMarker(plan, resolution)}`;
  installApi([
    threadResponse({ body: reply }),
    threadResponse({ body: reply }),
    ...validationResponses(),
    {
      body: {
        data: {
          resolveReviewThread: {
            thread: { id: resolution.threadId, isResolved: true },
          },
        },
      },
    },
    threadResponse({ body: reply }),
  ]);

  await expect(
    publishReviewThreadResolutions({ deps, pr, claim, plan }),
  ).rejects.toThrow(
    'publication blocked: review thread PRRT_thread remained unresolved',
  );
});
