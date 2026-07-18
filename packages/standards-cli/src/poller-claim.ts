import { randomUUID } from 'node:crypto';
import { hasLabel } from './github-label-identity';
import { type ApprovalBinding, readApprovalBinding } from './poller-approval';
import {
  collaboratorRole,
  getIssue,
  type IssueComment,
  lastLabelEvent,
  listIssueComments,
} from './poller-github';
import { createComment } from './poller-github-write';
import { CLAIM_MARKER, isTrustedRole } from './poller-protocol';

export type ClaimBinding = {
  readonly approval: ApprovalBinding;
  readonly claimLabel: string;
  readonly claimEpoch: string;
  readonly markerId: number;
};

type ClaimMarker = Omit<ClaimBinding, 'markerId'> & {
  readonly nonce: string;
};

type ClaimContext = {
  readonly token: string | null;
  readonly repo: string;
  readonly issueNumber: number;
};

const markerBody = (marker: ClaimMarker): string =>
  `${CLAIM_MARKER}\n${JSON.stringify(marker)}`;

const parseMarker = (comment: IssueComment): ClaimMarker | null => {
  if (!comment.body.startsWith(`${CLAIM_MARKER}\n`)) {
    return null;
  }
  try {
    const raw = JSON.parse(comment.body.slice(CLAIM_MARKER.length + 1)) as {
      readonly approval?: ApprovalBinding;
      readonly claimLabel?: unknown;
      readonly claimEpoch?: unknown;
      readonly nonce?: unknown;
    };
    if (
      typeof raw.claimLabel !== 'string' ||
      typeof raw.claimEpoch !== 'string' ||
      typeof raw.nonce !== 'string' ||
      raw.approval === undefined ||
      typeof raw.approval.id !== 'string'
    ) {
      return null;
    }
    return {
      approval: raw.approval,
      claimLabel: raw.claimLabel,
      claimEpoch: raw.claimEpoch,
      nonce: raw.nonce,
    };
  } catch {
    return null;
  }
};

const winningMarkerId = async (
  context: ClaimContext,
  binding: Omit<ClaimBinding, 'markerId'>,
): Promise<number | null> => {
  const comments = await listIssueComments(
    context.token,
    context.repo,
    context.issueNumber,
  );
  let winner: number | null = null;
  for (const comment of comments) {
    const marker = parseMarker(comment);
    const differs =
      marker?.approval.id !== binding.approval.id ||
      marker.claimLabel !== binding.claimLabel ||
      marker.claimEpoch !== binding.claimEpoch;
    if (!differs) {
      // biome-ignore lint/performance/noAwaitInLoops: claim authors must be checked against their current role; the usually-one-item list is deliberately fail-closed.
      const role = await collaboratorRole(
        context.token,
        context.repo,
        comment.authorLogin,
      );
      if (isTrustedRole(role) && (winner === null || comment.id < winner)) {
        winner = comment.id;
      }
    }
  }
  return winner;
};

export const acquireClaim = async (
  context: ClaimContext,
  approval: ApprovalBinding,
  claimLabel: string,
): Promise<ClaimBinding | null> => {
  const event = await lastLabelEvent(
    context.token,
    context.repo,
    context.issueNumber,
    claimLabel,
  );
  if (event === null) {
    throw new Error(`no "${claimLabel}" claim event found`);
  }
  const provisional = {
    approval,
    claimLabel,
    claimEpoch: event.createdAt,
  };
  const nonce = randomUUID();
  const markerId = await createComment(
    context.token,
    context.repo,
    context.issueNumber,
    markerBody({ ...provisional, nonce }),
  );
  const winner = await winningMarkerId(context, provisional);
  return winner === markerId ? { ...provisional, markerId } : null;
};

export const validateClaim = async (
  context: ClaimContext,
  claim: ClaimBinding,
  currentTarget: string,
): Promise<string | null> => {
  const current = await readApprovalBinding(
    context,
    claim.approval.label,
    currentTarget,
  );
  if (typeof current === 'string') {
    return current;
  }
  if (current.id !== claim.approval.id) {
    return 'approval no longer matches the exact approved revision/head';
  }
  const issue = await getIssue(
    context.token,
    context.repo,
    context.issueNumber,
  );
  if (!hasLabel(issue.labels, claim.claimLabel)) {
    return `"${claim.claimLabel}" is no longer present`;
  }
  const winner = await winningMarkerId(context, claim);
  return winner === claim.markerId
    ? null
    : 'claim ownership changed or could not be proven';
};
