import { apiError, HTTP_OK, request } from './github-api';
import { isRecord } from './github-settings-parse';

export type ReviewThreadComment = {
  readonly body: string;
  readonly viewerDidAuthor: boolean;
};

export type ReviewThread = {
  readonly id: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly isResolved: boolean;
  readonly creation: ReviewThreadComment | null;
  readonly viewerAuthoredBodies: ReadonlyArray<string>;
};

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

const reviewThreadComment = (
  value: unknown,
  context: string,
): ReviewThreadComment => {
  const comment = asRecord(value, context);
  return {
    body: stringField(comment, 'body', context),
    viewerDidAuthor: booleanField(comment, 'viewerDidAuthor', context),
  };
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
  const parsedComments = comments.nodes.map((comment) =>
    reviewThreadComment(comment, context),
  );
  const viewerAuthoredBodies: Array<string> = [];
  for (const comment of parsedComments) {
    if (comment.viewerDidAuthor) {
      viewerAuthoredBodies.push(comment.body);
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
      creation: parsedComments[0] ?? null,
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
    if (combined === null) {
      combined = { ...page.thread, viewerAuthoredBodies };
    } else if (combined.creation === null && page.thread.creation !== null) {
      const existing = combined as ReviewThread;
      combined = { ...existing, creation: page.thread.creation };
    }
    viewerAuthoredBodies.push(...page.thread.viewerAuthoredBodies);
    after = page.nextCursor;
  } while (after !== null);
  if (combined === null) {
    throw new Error(`read review thread ${threadId}: no response`);
  }
  return combined;
};
