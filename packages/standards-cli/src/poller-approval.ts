import { createHash } from 'node:crypto';
import { hasLabel } from './github-label-identity';
import {
  collaboratorRole,
  getIssue,
  type IssueItem,
  lastLabelEvent,
} from './poller-github';
import { isTrustedRole } from './poller-protocol';

export type ApprovalBinding = {
  readonly id: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly eventId: number;
  readonly label: string;
  readonly actorLogin: string;
  readonly approvedAt: string;
  readonly target: string;
};

type ApprovalContext = {
  readonly token: string | null;
  readonly repo: string;
  readonly issueNumber: number;
};

const stableDigest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const issueRevision = (issue: IssueItem): string =>
  `issue:${stableDigest({ title: issue.title, body: issue.body })}`;

export const prRevision = (
  baseRef: string,
  baseSha: string,
  headSha: string,
): string => `pr:${stableDigest({ baseRef, baseSha, headSha })}`;

export const readApprovalBinding = async (
  context: ApprovalContext,
  label: string,
  target: string,
): Promise<ApprovalBinding | string> => {
  const issue = await getIssue(
    context.token,
    context.repo,
    context.issueNumber,
  );
  if (!hasLabel(issue.labels, label)) {
    return `"${label}" is not currently present on ${context.repo}#${context.issueNumber}`;
  }
  const event = await lastLabelEvent(
    context.token,
    context.repo,
    context.issueNumber,
    label,
  );
  if (event === null) {
    return `no "${label}" label event found on ${context.repo}#${context.issueNumber}`;
  }
  const role = await collaboratorRole(
    context.token,
    context.repo,
    event.actorLogin,
  );
  if (!isTrustedRole(role)) {
    return `"${label}" on ${context.repo}#${context.issueNumber} was applied by ${event.actorLogin} (role: ${role}); only admin or maintain roles may approve automation`;
  }
  const fields = {
    repo: context.repo,
    issueNumber: context.issueNumber,
    eventId: event.id,
    label,
    actorLogin: event.actorLogin,
    approvedAt: event.createdAt,
    target,
  };
  return { id: stableDigest(fields), ...fields };
};
