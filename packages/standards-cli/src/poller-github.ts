// Read-side GitHub helpers for the poller. Every function either returns a
// narrow parsed shape or throws with the failing endpoint in the message; the
// tick converts per-job throws into reported problems. Lists are always read
// exhaustively (see github-paginate.ts) — the trust anchor is "the latest
// label event", which a truncated page would silently falsify.

import { apiError, HTTP_OK, request } from './github-api';
import { labelIdentity } from './github-label-identity';
import { listAllPages } from './github-paginate';
import { isNonEmptyString, isRecord } from './github-settings-parse';

export type IssueItem = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly isPullRequest: boolean;
  readonly labels: ReadonlyArray<string>;
  readonly authorLogin: string;
};

export type IssueComment = {
  readonly id: number;
  readonly body: string;
  readonly authorLogin: string;
  readonly createdAt: string;
};

export type LabelEvent = {
  readonly actorLogin: string;
  readonly createdAt: string;
};

const asString = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const labelNames = (raw: unknown): ReadonlyArray<string> =>
  Array.isArray(raw)
    ? raw
        .map((label) => (isRecord(label) ? asString(label.name) : ''))
        .filter((name) => name.length > 0)
    : [];

export const parseIssue = (raw: unknown): IssueItem | null => {
  if (!(isRecord(raw) && typeof raw.number === 'number')) {
    return null;
  }
  return {
    number: raw.number,
    title: asString(raw.title),
    body: asString(raw.body),
    isPullRequest: isRecord(raw.pull_request),
    labels: labelNames(raw.labels),
    authorLogin: isRecord(raw.user) ? asString(raw.user.login) : '',
  };
};

export const getIssue = async (
  token: string | null,
  repo: string,
  issueNumber: number,
): Promise<IssueItem> => {
  const response = await request(
    token,
    'GET',
    `/repos/${repo}/issues/${issueNumber}`,
  );
  const issue = response.status === HTTP_OK ? parseIssue(response.body) : null;
  if (issue === null) {
    throw new Error(apiError(`read ${repo}#${issueNumber}`, response));
  }
  return issue;
};

export const listOpenIssuesWithLabel = async (
  token: string | null,
  repo: string,
  label: string,
): Promise<ReadonlyArray<IssueItem>> => {
  const items = await listAllPages(
    token,
    `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`,
    `list ${repo} issues labeled ${label}`,
  );
  return items
    .map(parseIssue)
    .filter((issue): issue is IssueItem => issue !== null);
};

export const listIssueComments = async (
  token: string | null,
  repo: string,
  issueNumber: number,
): Promise<ReadonlyArray<IssueComment>> => {
  const items = await listAllPages(
    token,
    `/repos/${repo}/issues/${issueNumber}/comments`,
    `list ${repo}#${issueNumber} comments`,
  );
  return items.flatMap((raw) => {
    if (!(isRecord(raw) && typeof raw.id === 'number')) {
      return [];
    }
    return [
      {
        id: raw.id,
        body: asString(raw.body),
        authorLogin: isRecord(raw.user) ? asString(raw.user.login) : '',
        createdAt: asString(raw.created_at),
      },
    ];
  });
};

// The most recent `labeled` event for a label, from the full issue timeline.
// This is the poller's trust anchor (who approved) and its claim clock (when
// the in-progress label was applied); reading anything less than the full
// timeline would let a stale event stand in for the latest one.
export const lastLabelEvent = async (
  token: string | null,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<LabelEvent | null> => {
  const expectedIdentity = labelIdentity(label);
  const events = await listAllPages(
    token,
    `/repos/${repo}/issues/${issueNumber}/timeline`,
    `read ${repo}#${issueNumber} timeline`,
  );
  let latest: LabelEvent | null = null;
  for (const raw of events) {
    if (
      isRecord(raw) &&
      raw.event === 'labeled' &&
      isRecord(raw.label) &&
      typeof raw.label.name === 'string' &&
      labelIdentity(raw.label.name) === expectedIdentity &&
      isRecord(raw.actor) &&
      isNonEmptyString(raw.actor.login) &&
      isNonEmptyString(raw.created_at)
    ) {
      latest = { actorLogin: raw.actor.login, createdAt: raw.created_at };
    }
  }
  return latest;
};

// role_name distinguishes maintain from write; the legacy `permission` field
// collapses both to "write" and cannot express the trust boundary. A 404
// means "not a collaborator" — an untrusted answer, not an API failure.
export const collaboratorRole = async (
  token: string | null,
  repo: string,
  username: string,
): Promise<string> => {
  const HttpNotFound = 404;
  const response = await request(
    token,
    'GET',
    `/repos/${repo}/collaborators/${encodeURIComponent(username)}/permission`,
  );
  if (response.status === HttpNotFound) {
    return 'none';
  }
  if (response.status !== HTTP_OK || !isRecord(response.body)) {
    throw new Error(apiError(`read ${repo} role for ${username}`, response));
  }
  return asString(response.body.role_name);
};

export const repoDefaultBranch = async (
  token: string | null,
  repo: string,
): Promise<string> => {
  const response = await request(token, 'GET', `/repos/${repo}`);
  if (
    response.status !== HTTP_OK ||
    !isRecord(response.body) ||
    !isNonEmptyString(response.body.default_branch)
  ) {
    throw new Error(apiError(`read ${repo} default branch`, response));
  }
  return response.body.default_branch;
};
