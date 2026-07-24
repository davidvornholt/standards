import { apiError, HTTP_OK, request } from './github-api';
import { isRecord } from './github-settings-parse';

export type ReviewThread = {
  readonly id: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly isResolved: boolean;
  readonly viewerAuthoredBodies: ReadonlyArray<string>;
};

const REPLY_MUTATION =
  // biome-ignore lint/security/noSecrets: a GraphQL mutation string, not a credential.
  'mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }';

const RESOLVE_MUTATION =
  'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }';

const asRecord = (
  value: unknown,
  context: string,
): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) {
    throw new Error(`${context}: expected an object`);
  }
  return value;
};

const stringField = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  context: string,
): string => {
  const field = value[key];
  if (typeof field !== 'string') {
    throw new Error(`${context}: expected "${key}" to be a string`);
  }
  return field;
};

const booleanField = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  context: string,
): boolean => {
  const field = value[key];
  if (typeof field !== 'boolean') {
    throw new Error(`${context}: expected "${key}" to be a boolean`);
  }
  return field;
};

const numberField = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  context: string,
): number => {
  const field = value[key];
  if (typeof field !== 'number') {
    throw new Error(`${context}: expected "${key}" to be a number`);
  }
  return field;
};

const viewerAuthoredComment = (
  value: unknown,
  context: string,
): string | null => {
  const comment = asRecord(value, context);
  const body = stringField(comment, 'body', context);
  return booleanField(comment, 'viewerDidAuthor', context) ? body : null;
};

const readThreadPage = async (
  token: string | null,
  threadId: string,
  after: string | null,
): Promise<{
  readonly thread: ReviewThread;
  readonly nextCursor: string | null;
}> => {
  const response = await request(token, 'POST', '/graphql', {
    query:
      'query($id: ID!, $after: String) { node(id: $id) { ... on PullRequestReviewThread { id isResolved pullRequest { number repository { nameWithOwner } } comments(first: 100, after: $after) { nodes { body viewerDidAuthor } pageInfo { hasNextPage endCursor } } } } }',
    variables: { id: threadId, after },
  });
  if (response.status !== HTTP_OK) {
    throw new Error(apiError(`read review thread ${threadId}`, response));
  }
  const context = `read review thread ${threadId}`;
  const body = asRecord(response.body, context);
  if (body.errors !== undefined) {
    throw new Error(apiError(context, response));
  }
  const data = asRecord(body.data, context);
  const node = asRecord(data.node, context);
  if (stringField(node, 'id', context) !== threadId) {
    throw new Error(`${context}: GitHub returned a different node`);
  }
  const pullRequest = asRecord(node.pullRequest, context);
  const repository = asRecord(pullRequest.repository, context);
  const comments = asRecord(node.comments, context);
  const pageInfo = asRecord(comments.pageInfo, context);
  if (!Array.isArray(comments.nodes)) {
    throw new Error(`${context}: expected thread comments`);
  }
  const viewerAuthoredBodies: Array<string> = [];
  for (const comment of comments.nodes) {
    const authored = viewerAuthoredComment(comment, context);
    if (authored !== null) {
      viewerAuthoredBodies.push(authored);
    }
  }
  const hasNextPage = booleanField(pageInfo, 'hasNextPage', context);
  const { endCursor } = pageInfo;
  if (hasNextPage && typeof endCursor !== 'string') {
    throw new Error(`${context}: expected the next comment cursor`);
  }
  return {
    thread: {
      id: threadId,
      repo: stringField(repository, 'nameWithOwner', context),
      prNumber: numberField(pullRequest, 'number', context),
      isResolved: booleanField(node, 'isResolved', context),
      viewerAuthoredBodies,
    },
    nextCursor: hasNextPage ? (endCursor as string) : null,
  };
};

export const readReviewThread = async (
  token: string | null,
  threadId: string,
): Promise<ReviewThread> => {
  let after: string | null = null;
  let combined: ReviewThread | null = null;
  const viewerAuthoredBodies: Array<string> = [];
  do {
    // biome-ignore lint/performance/noAwaitInLoops: all comment pages are required for replay-safe marker lookup.
    const page = await readThreadPage(token, threadId, after);
    if (
      combined !== null &&
      (combined.repo !== page.thread.repo ||
        combined.prNumber !== page.thread.prNumber ||
        combined.isResolved !== page.thread.isResolved)
    ) {
      throw new Error(`read review thread ${threadId}: identity changed`);
    }
    combined = {
      ...page.thread,
      viewerAuthoredBodies,
    };
    viewerAuthoredBodies.push(...page.thread.viewerAuthoredBodies);
    after = page.nextCursor;
  } while (after !== null);
  if (combined === null) {
    throw new Error(`read review thread ${threadId}: no response`);
  }
  return combined;
};

const mutateThread = async (
  token: string | null,
  operation: 'reply' | 'resolve',
  threadId: string,
  body?: string,
): Promise<void> => {
  const replying = operation === 'reply';
  const response = await request(token, 'POST', '/graphql', {
    query: replying ? REPLY_MUTATION : RESOLVE_MUTATION,
    variables: replying ? { id: threadId, body } : { id: threadId },
  });
  if (
    response.status !== HTTP_OK ||
    !isRecord(response.body) ||
    response.body.errors !== undefined
  ) {
    throw new Error(
      apiError(`${operation} review thread ${threadId}`, response),
    );
  }
};

export const replyToReviewThread = (
  token: string | null,
  threadId: string,
  body: string,
): Promise<void> => mutateThread(token, 'reply', threadId, body);

export const resolveReviewThread = (
  token: string | null,
  threadId: string,
): Promise<void> => mutateThread(token, 'resolve', threadId);
