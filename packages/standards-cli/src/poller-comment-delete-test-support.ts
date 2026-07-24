import { HTTP_NO_CONTENT } from './github-api';
import { installPollerApi } from './poller-api-test-support';

export const installPollerApiWithCommentDeletes = (
  options: Parameters<typeof installPollerApi>[0],
) => {
  const calls = installPollerApi(options);
  const apiFetch = globalThis.fetch;
  const deletedCommentIds: Array<number> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === 'DELETE' && path.includes('/issues/comments/')) {
      deletedCommentIds.push(Number(path.split('/').at(-1)));
      return Promise.resolve(new Response(null, { status: HTTP_NO_CONTENT }));
    }
    return apiFetch(input, init);
  }) as typeof fetch;
  return { calls, deletedCommentIds };
};
