import { hasLabel } from './github-label-identity';
import {
  type ApprovalBinding,
  issueRevision,
  prRevision,
  readApprovalBinding,
} from './poller-approval';
import { hiddenCommentMetadata } from './poller-comment-metadata';
import { getIssue } from './poller-github';
import { getPullRequest } from './poller-github-pulls';
import { createComment, deleteComment } from './poller-github-write';
import type { JobDeps } from './poller-job-shared';
import { NEEDS_CLARIFICATION, QUEUE_METADATA_MARKER } from './poller-protocol';
import {
  approvalLabelFor,
  inProgressLabelFor,
  matchingTrustedQueueCommentIds,
  type PollerJobKind,
  queueMarkerFor,
} from './poller-queue-marker';

const queuedMessage = (kind: PollerJobKind) =>
  kind === 'fix'
    ? '**Fix queued**\n\nThe poller has picked this up and will start work as soon as a run is available. You don’t need to do anything else.'
    : '**Review queued**\n\nThe poller has picked this up and will start the review as soon as a run is available. You don’t need to do anything else.';

const isStillQueueable = async (
  deps: JobDeps,
  issueNumber: number,
  approval: ApprovalBinding,
  kind: PollerJobKind,
): Promise<boolean> => {
  const expectedApprovalLabel = approvalLabelFor(kind);
  if (
    approval.repo !== deps.repo ||
    approval.issueNumber !== issueNumber ||
    approval.label !== expectedApprovalLabel
  ) {
    return false;
  }
  const issue = await getIssue(deps.token, deps.repo, issueNumber);
  if (
    !hasLabel(issue.labels, expectedApprovalLabel) ||
    hasLabel(issue.labels, inProgressLabelFor(kind)) ||
    hasLabel(issue.labels, NEEDS_CLARIFICATION)
  ) {
    return false;
  }
  const target =
    kind === 'fix'
      ? issueRevision(issue)
      : await getPullRequest(deps.token, deps.repo, issueNumber).then((pr) =>
          prRevision(pr.baseRef, pr.baseSha, pr.headSha),
        );
  if (target !== approval.target) {
    return false;
  }
  const currentApproval = await readApprovalBinding(
    {
      token: deps.token,
      repo: deps.repo,
      issueNumber,
    },
    expectedApprovalLabel,
    target,
  );
  return (
    typeof currentApproval !== 'string' && currentApproval.id === approval.id
  );
};

export const acknowledgeQueuedJob = async (
  deps: JobDeps,
  issueNumber: number,
  approval: ApprovalBinding,
  kind: PollerJobKind,
): Promise<boolean> => {
  const expected = queueMarkerFor(approval, kind);
  const current = await getIssue(deps.token, deps.repo, issueNumber);
  if (
    hasLabel(current.labels, inProgressLabelFor(kind)) ||
    hasLabel(current.labels, NEEDS_CLARIFICATION)
  ) {
    return false;
  }
  if (
    (
      await matchingTrustedQueueCommentIds(
        deps,
        issueNumber,
        expected.approvalId,
        kind,
      )
    ).length > 0
  ) {
    return false;
  }
  const markerId = await createComment(
    deps.token,
    deps.repo,
    issueNumber,
    `${queuedMessage(kind)}\n\n${hiddenCommentMetadata(
      QUEUE_METADATA_MARKER,
      expected,
    )}`,
  );
  const [winner] = [
    ...(await matchingTrustedQueueCommentIds(
      deps,
      issueNumber,
      expected.approvalId,
      kind,
    )),
  ].sort((left, right) => left - right);
  if (winner !== markerId) {
    await deleteComment(deps.token, deps.repo, markerId);
    return false;
  }
  if (!(await isStillQueueable(deps, issueNumber, approval, kind))) {
    await deleteComment(deps.token, deps.repo, markerId);
    return false;
  }
  return true;
};
