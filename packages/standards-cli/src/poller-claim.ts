import { randomUUID } from 'node:crypto';
import { hasLabel } from './github-label-identity';
import { type ApprovalBinding, readApprovalBinding } from './poller-approval';
import type { ClaimMarkerBinding } from './poller-claim-reconciliation';
import { matchingTrustedClaimMarkerIds } from './poller-claim-reconciliation';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import { retainEarliestComment } from './poller-comment-reconciliation';
import { getIssue, lastLabelEvent } from './poller-github';
import { createComment, deleteComment } from './poller-github-write';
import {
  CLAIM_METADATA_MARKER,
  FIX_IN_PROGRESS,
  REVIEW_IN_PROGRESS,
} from './poller-protocol';

export type ClaimBinding = ClaimMarkerBinding & {
  readonly markerId: number;
};

type ClaimMarker = ClaimMarkerBinding & {
  readonly nonce: string;
};

type ClaimContext = {
  readonly token: string | null;
  readonly repo: string;
  readonly issueNumber: number;
};

const startedMessage = (claimLabel: string) => {
  if (claimLabel === FIX_IN_PROGRESS) {
    return '**Fix started**\n\nThe poller is working on this issue now. It’ll open a draft pull request when the fix is ready, or ask here if it needs your input.';
  }
  if (claimLabel === REVIEW_IN_PROGRESS) {
    return '**Review started**\n\nThe poller is reviewing this pull request now. It’ll post the results and take the pull request out of draft when it’s finished, or ask here if it needs your input.';
  }
  throw new Error(`unsupported poller claim label: ${claimLabel}`);
};

const markerBody = (marker: ClaimMarker): string =>
  `${startedMessage(marker.claimLabel)}\n\n${hiddenCommentMetadata(
    CLAIM_METADATA_MARKER,
    marker,
  )}`;

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
    claimEpoch: String(event.id),
  };
  const nonce = randomUUID();
  const markerId = await createComment(
    context.token,
    context.repo,
    context.issueNumber,
    markerBody({ ...provisional, nonce }),
  );
  const markerIds = await matchingTrustedClaimMarkerIds(context, provisional);
  const winner = await retainEarliestComment(context, markerIds);
  if (winner !== markerId) {
    if (!markerIds.includes(markerId)) {
      await deleteComment(context.token, context.repo, markerId);
    }
    return null;
  }
  return { ...provisional, markerId };
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
  if (current.kind === 'absent') {
    return `"${claim.approval.label}" is not currently present`;
  }
  if (current.kind === 'rejected') {
    return current.reason;
  }
  if (current.approval.id !== claim.approval.id) {
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
  const winner = await retainEarliestComment(
    context,
    await matchingTrustedClaimMarkerIds(context, claim),
  );
  return winner === claim.markerId
    ? null
    : 'claim ownership changed or could not be proven';
};
