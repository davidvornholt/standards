import { apiError, HTTP_OK, request } from './github-api';
import { isRecord } from './github-settings-parse';

const REPLY_MUTATION =
  // biome-ignore lint/security/noSecrets: a GraphQL mutation string, not a credential.
  'mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }';

const RESOLVE_MUTATION =
  'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }';

const mutationBody = (
  operation: 'reply' | 'resolve',
  threadId: string,
  response: Awaited<ReturnType<typeof request>>,
): Readonly<Record<string, unknown>> => {
  const context = `${operation} review thread ${threadId}`;
  if (
    response.status !== HTTP_OK ||
    !isRecord(response.body) ||
    response.body.errors !== undefined ||
    !isRecord(response.body.data)
  ) {
    throw new Error(apiError(context, response));
  }
  return response.body.data;
};

export const replyToReviewThread = async (
  token: string | null,
  threadId: string,
  body: string,
): Promise<void> => {
  const response = await request(token, 'POST', '/graphql', {
    query: REPLY_MUTATION,
    variables: { id: threadId, body },
  });
  const data = mutationBody('reply', threadId, response);
  const payload = data.addPullRequestReviewThreadReply;
  if (
    !(isRecord(payload) && isRecord(payload.comment)) ||
    typeof payload.comment.id !== 'string'
  ) {
    throw new Error(apiError(`reply review thread ${threadId}`, response));
  }
};

export const resolveReviewThread = async (
  token: string | null,
  threadId: string,
): Promise<void> => {
  const response = await request(token, 'POST', '/graphql', {
    query: RESOLVE_MUTATION,
    variables: { id: threadId },
  });
  const data = mutationBody('resolve', threadId, response);
  const payload = data.resolveReviewThread;
  if (
    !(isRecord(payload) && isRecord(payload.thread)) ||
    payload.thread.id !== threadId ||
    payload.thread.isResolved !== true
  ) {
    throw new Error(apiError(`resolve review thread ${threadId}`, response));
  }
};
