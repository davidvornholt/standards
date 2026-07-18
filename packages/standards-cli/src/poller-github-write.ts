// Write-side label and comment operations for the poller. Kept apart from the
// read helpers so each module stays a single reviewable concern.

import { apiError, HTTP_CREATED, HTTP_OK, request } from './github-api';
import { isRecord } from './github-settings-parse';

const HTTP_NOT_FOUND = 404;

export const addLabels = async (
  token: string | null,
  repo: string,
  issueNumber: number,
  labels: ReadonlyArray<string>,
): Promise<void> => {
  const response = await request(
    token,
    'POST',
    `/repos/${repo}/issues/${issueNumber}/labels`,
    { labels: [...labels] },
  );
  if (response.status !== HTTP_OK) {
    throw new Error(
      apiError(`add ${labels.join(', ')} to ${repo}#${issueNumber}`, response),
    );
  }
};

// Removing an already-absent label is success, not failure: ticks are
// re-runnable and a crashed predecessor may have completed this step.
export const removeLabel = async (
  token: string | null,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> => {
  const response = await request(
    token,
    'DELETE',
    `/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
  );
  if (response.status !== HTTP_OK && response.status !== HTTP_NOT_FOUND) {
    throw new Error(
      apiError(`remove ${label} from ${repo}#${issueNumber}`, response),
    );
  }
};

export const createIssue = async (
  token: string | null,
  repo: string,
  options: {
    readonly title: string;
    readonly body: string;
    readonly labels: ReadonlyArray<string>;
  },
): Promise<void> => {
  const response = await request(token, 'POST', `/repos/${repo}/issues`, {
    title: options.title,
    body: options.body,
    labels: [...options.labels],
  });
  if (response.status !== HTTP_CREATED) {
    throw new Error(apiError(`create issue in ${repo}`, response));
  }
};

export const createComment = async (
  token: string | null,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<number> => {
  const response = await request(
    token,
    'POST',
    `/repos/${repo}/issues/${issueNumber}/comments`,
    { body },
  );
  if (
    response.status !== HTTP_CREATED ||
    !isRecord(response.body) ||
    typeof response.body.id !== 'number'
  ) {
    throw new Error(apiError(`comment on ${repo}#${issueNumber}`, response));
  }
  return response.body.id;
};
