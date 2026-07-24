import { hasLabel } from './github-label-identity';
import type { ApprovalBinding } from './poller-approval';
import {
  hiddenCommentMetadata,
  parseHiddenCommentMetadata,
} from './poller-comment-metadata';
import { getIssue, listIssueComments } from './poller-github';
import { createComment, deleteComment } from './poller-github-write';
import type { JobDeps } from './poller-job-shared';
import {
  FIX_IN_PROGRESS,
  isTrustedRole,
  NEEDS_CLARIFICATION,
  QUEUE_METADATA_MARKER,
  REVIEW_IN_PROGRESS,
} from './poller-protocol';
import { cachedCollaboratorRole } from './poller-trust';

export type PollerJobKind = 'fix' | 'review';

type QueueMarker = {
  readonly approvalId: string;
  readonly kind: PollerJobKind;
};

const queuedMessage = (kind: PollerJobKind) =>
  kind === 'fix'
    ? '**Fix queued**\n\nThe poller has picked this up and will start work as soon as a run is available. You don’t need to do anything else.'
    : '**Review queued**\n\nThe poller has picked this up and will start the review as soon as a run is available. You don’t need to do anything else.';

const queueMarker = (body: string): QueueMarker | null => {
  const raw = parseHiddenCommentMetadata(body, QUEUE_METADATA_MARKER);
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const candidate = raw as {
    readonly approvalId?: unknown;
    readonly kind?: unknown;
  };
  if (
    typeof candidate.approvalId !== 'string' ||
    (candidate.kind !== 'fix' && candidate.kind !== 'review')
  ) {
    return null;
  }
  return { approvalId: candidate.approvalId, kind: candidate.kind };
};

const matchingTrustedCommentIds = async (
  deps: JobDeps,
  issueNumber: number,
  expected: QueueMarker,
): Promise<ReadonlyArray<number>> => {
  const comments = await listIssueComments(deps.token, deps.repo, issueNumber);
  const ids: Array<number> = [];
  for (const comment of comments) {
    const marker = queueMarker(comment.body);
    if (
      marker?.approvalId === expected.approvalId &&
      marker.kind === expected.kind
    ) {
      // biome-ignore lint/performance/noAwaitInLoops: role reads use the shared per-tick cache; marker authorship is a trust boundary.
      const role = await cachedCollaboratorRole(
        {
          token: deps.token,
          repo: deps.repo,
          issueNumber,
          roleCache: deps.roleCache,
        },
        comment.authorLogin,
      );
      if (isTrustedRole(role)) {
        ids.push(comment.id);
      }
    }
  }
  return ids;
};

const inProgressLabel = (kind: PollerJobKind) =>
  kind === 'fix' ? FIX_IN_PROGRESS : REVIEW_IN_PROGRESS;

export const acknowledgeQueuedJob = async (
  deps: JobDeps,
  issueNumber: number,
  approval: ApprovalBinding,
  kind: PollerJobKind,
): Promise<boolean> => {
  const expected = { approvalId: approval.id, kind };
  const current = await getIssue(deps.token, deps.repo, issueNumber);
  if (
    hasLabel(current.labels, inProgressLabel(kind)) ||
    hasLabel(current.labels, NEEDS_CLARIFICATION)
  ) {
    return false;
  }
  if (
    (await matchingTrustedCommentIds(deps, issueNumber, expected)).length > 0
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
    ...(await matchingTrustedCommentIds(deps, issueNumber, expected)),
  ].sort((left, right) => left - right);
  if (winner !== markerId) {
    await deleteComment(deps.token, deps.repo, markerId);
    return false;
  }
  const after = await getIssue(deps.token, deps.repo, issueNumber);
  if (hasLabel(after.labels, inProgressLabel(kind))) {
    await deleteComment(deps.token, deps.repo, markerId);
    return false;
  }
  return true;
};
