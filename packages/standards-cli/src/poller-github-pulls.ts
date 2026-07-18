// Pull-request operations for the poller: creating the draft PR that carries
// a fix, reading PR state for review jobs, posting the review report, and
// flipping draft to ready (GraphQL: REST cannot change the draft flag).

import { apiError, HTTP_CREATED, HTTP_OK, request } from './github-api';
import { isNonEmptyString, isRecord } from './github-settings-parse';

export type PullRequest = {
  readonly number: number;
  readonly title: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly headRepo: string;
  readonly baseRef: string;
  readonly nodeId: string;
  readonly draft: boolean;
};

const HTTP_UNPROCESSABLE = 422;

const findOpenPullRequestForHead = async (
  token: string | null,
  repo: string,
  head: string,
): Promise<number | null> => {
  const [owner = ''] = repo.split('/');
  const response = await request(
    token,
    'GET',
    `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`,
  );
  if (response.status !== HTTP_OK || !Array.isArray(response.body)) {
    return null;
  }
  const [first] = response.body;
  return isRecord(first) && typeof first.number === 'number'
    ? first.number
    : null;
};

// A retry after a crash between push and label release finds the PR already
// open; GitHub answers 422. Reusing that PR is the correct completion of the
// interrupted job, not an error.
export const createDraftPullRequest = async (
  token: string | null,
  repo: string,
  options: {
    readonly title: string;
    readonly body: string;
    readonly head: string;
    readonly base: string;
  },
): Promise<number> => {
  const response = await request(token, 'POST', `/repos/${repo}/pulls`, {
    title: options.title,
    body: options.body,
    head: options.head,
    base: options.base,
    draft: true,
  });
  if (
    response.status === HTTP_CREATED &&
    isRecord(response.body) &&
    typeof response.body.number === 'number'
  ) {
    return response.body.number;
  }
  if (response.status === HTTP_UNPROCESSABLE) {
    const existing = await findOpenPullRequestForHead(
      token,
      repo,
      options.head,
    );
    if (existing !== null) {
      return existing;
    }
  }
  throw new Error(apiError(`create draft PR in ${repo}`, response));
};

export const getPullRequest = async (
  token: string | null,
  repo: string,
  prNumber: number,
): Promise<PullRequest> => {
  const response = await request(
    token,
    'GET',
    `/repos/${repo}/pulls/${prNumber}`,
  );
  const { body } = response;
  if (
    response.status !== HTTP_OK ||
    !isRecord(body) ||
    !isRecord(body.head) ||
    !isRecord(body.base) ||
    !isNonEmptyString(body.node_id)
  ) {
    throw new Error(apiError(`read ${repo}#${prNumber}`, response));
  }
  const headRepo = isRecord(body.head.repo)
    ? body.head.repo
    : ({} as Record<string, unknown>);
  return {
    number: prNumber,
    title: isNonEmptyString(body.title) ? body.title : '',
    headRef: isNonEmptyString(body.head.ref) ? body.head.ref : '',
    headSha: isNonEmptyString(body.head.sha) ? body.head.sha : '',
    headRepo: isNonEmptyString(headRepo.full_name) ? headRepo.full_name : '',
    baseRef: isNonEmptyString(body.base.ref) ? body.base.ref : '',
    nodeId: body.node_id,
    draft: body.draft === true,
  };
};

export const createPullRequestReview = async (
  token: string | null,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> => {
  const response = await request(
    token,
    'POST',
    `/repos/${repo}/pulls/${prNumber}/reviews`,
    { event: 'COMMENT', body },
  );
  if (response.status !== HTTP_OK) {
    throw new Error(apiError(`post review on ${repo}#${prNumber}`, response));
  }
};

export const markPullRequestReady = async (
  token: string | null,
  pullRequestNodeId: string,
): Promise<void> => {
  const response = await request(token, 'POST', '/graphql', {
    query:
      // biome-ignore lint/security/noSecrets: a GraphQL mutation string, not a credential.
      'mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }',
    variables: { id: pullRequestNodeId },
  });
  const succeeded =
    response.status === HTTP_OK &&
    isRecord(response.body) &&
    response.body.errors === undefined;
  if (!succeeded) {
    throw new Error(apiError('mark PR ready for review', response));
  }
};
