import { randomUUID } from 'node:crypto';
import { hasLabel } from './github-label-identity';
import { type ApprovalBinding, readApprovalBinding } from './poller-approval';
import {
  type ClaimMarkerBinding,
  reconcileTrustedClaimElection,
  reconcileTrustedClaimHistory,
} from './poller-claim-reconciliation';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import { getIssue, lastLabelEvent } from './poller-github';
import {
  addLabels,
  createComment,
  deleteComment,
  removeLabel,
} from './poller-github-write';
import type { JobDeps } from './poller-job-shared';
import {
  CLAIM_METADATA_MARKER,
  FIX_IN_PROGRESS,
  REVIEW_IN_PROGRESS,
} from './poller-protocol';
import { inProgressLabelFor, type PollerJobKind } from './poller-queue-marker';
import { reconcileExistingQueuedJob } from './poller-status';

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
  const election = await reconcileTrustedClaimElection(context, provisional);
  if (election.retainedId !== markerId) {
    if (!election.markerIds.includes(markerId)) {
      await deleteComment(context.token, context.repo, markerId);
    }
    return null;
  }
  return { ...provisional, markerId };
};

export const startClaim = async (
  deps: JobDeps,
  issueNumber: number,
  approval: ApprovalBinding,
  kind: PollerJobKind,
): Promise<ClaimBinding | null> => {
  await reconcileExistingQueuedJob(deps, issueNumber, approval, kind);
  const claimLabel = inProgressLabelFor(kind);
  await reconcileTrustedClaimHistory(
    { token: deps.token, repo: deps.repo, issueNumber },
    claimLabel,
  );
  await addLabels(deps.token, deps.repo, issueNumber, [claimLabel]);
  return acquireClaim(
    { token: deps.token, repo: deps.repo, issueNumber },
    approval,
    claimLabel,
  );
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
  const election = await reconcileTrustedClaimElection(context, claim);
  return election.retainedId === claim.markerId
    ? null
    : 'claim ownership changed or could not be proven';
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const releaseOwnedClaim = async (
  deps: JobDeps,
  issueNumber: number,
  claim: ClaimBinding,
): Promise<void> => {
  const context = { token: deps.token, repo: deps.repo, issueNumber };
  const election = await reconcileTrustedClaimElection(context, claim);
  const issue = await getIssue(deps.token, deps.repo, issueNumber);
  const event = await lastLabelEvent(
    deps.token,
    deps.repo,
    issueNumber,
    claim.claimLabel,
  );
  if (
    election.retainedId === claim.markerId &&
    hasLabel(issue.labels, claim.claimLabel) &&
    String(event?.id) === claim.claimEpoch
  ) {
    await removeLabel(deps.token, deps.repo, issueNumber, claim.claimLabel);
  }
};

export const withClaimReleasedOnFailure = async <Result>(
  deps: JobDeps,
  issueNumber: number,
  claim: ClaimBinding,
  operation: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch (operationError) {
    try {
      await releaseOwnedClaim(deps, issueNumber, claim);
    } catch (releaseError) {
      throw new Error(
        `${errorMessage(operationError)}; releasing the claim for an automatic retry also failed: ${errorMessage(releaseError)}`,
        {
          cause: releaseError,
        },
      );
    }
    throw operationError;
  }
};
