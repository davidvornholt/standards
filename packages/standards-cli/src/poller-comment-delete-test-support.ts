import { HTTP_NO_CONTENT } from './github-api';
import { installPollerApi } from './poller-api-test-support';

const HTTP_INTERNAL_SERVER_ERROR = 500;

const installPollerApiWithCommentDeleteStatus = (
  options: Parameters<typeof installPollerApi>[0],
  status: number,
) => {
  const calls = installPollerApi(options);
  const apiFetch = globalThis.fetch;
  const deletedCommentIds: Array<number> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === 'DELETE' && path.includes('/issues/comments/')) {
      deletedCommentIds.push(Number(path.split('/').at(-1)));
      return Promise.resolve(
        new Response(
          status === HTTP_NO_CONTENT
            ? null
            : JSON.stringify({ message: 'transient failure' }),
          { status },
        ),
      );
    }
    return apiFetch(input, init);
  }) as typeof fetch;
  return { calls, deletedCommentIds };
};

export const installPollerApiWithCommentDeletes = (
  options: Parameters<typeof installPollerApi>[0],
) => installPollerApiWithCommentDeleteStatus(options, HTTP_NO_CONTENT);

export const installPollerApiWithFailingCommentDelete = (
  options: Parameters<typeof installPollerApi>[0],
) =>
  installPollerApiWithCommentDeleteStatus(options, HTTP_INTERNAL_SERVER_ERROR);
