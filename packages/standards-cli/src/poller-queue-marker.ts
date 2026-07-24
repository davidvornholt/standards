import { hasLabel } from './github-label-identity';
import type { ApprovalBinding } from './poller-approval';
import { parseHiddenCommentMetadata } from './poller-comment-metadata';
import {
  type IssueComment,
  type IssueItem,
  lastLabelEvent,
  listIssueComments,
} from './poller-github';
import type { JobDeps } from './poller-job-shared';
import {
  APPROVED_FOR_FIX,
  APPROVED_FOR_REVIEW,
  FIX_IN_PROGRESS,
  isTrustedRole,
  NEEDS_CLARIFICATION,
  QUEUE_METADATA_MARKER,
  REVIEW_IN_PROGRESS,
} from './poller-protocol';
import { cachedCollaboratorRole } from './poller-trust';

export type PollerJobKind = 'fix' | 'review';

type ApprovalCheckpoint = {
  readonly actorLogin: string;
  readonly approvedAt: string;
  readonly eventId: number;
  readonly target: string;
};

type QueueMarker = {
  readonly approvalId: string;
  readonly kind: PollerJobKind;
  readonly approval: ApprovalCheckpoint | null;
};

export const inProgressLabelFor = (kind: PollerJobKind) =>
  kind === 'fix' ? FIX_IN_PROGRESS : REVIEW_IN_PROGRESS;

export const approvalLabelFor = (kind: PollerJobKind) =>
  kind === 'fix' ? APPROVED_FOR_FIX : APPROVED_FOR_REVIEW;

export const queueMarkerFor = (
  approval: ApprovalBinding,
  kind: PollerJobKind,
): QueueMarker => ({
  approvalId: approval.id,
  kind,
  approval: {
    actorLogin: approval.actorLogin,
    approvedAt: approval.approvedAt,
    eventId: approval.eventId,
    target: approval.target,
  },
});

const queueMarker = (body: string): QueueMarker | null => {
  const raw = parseHiddenCommentMetadata(body, QUEUE_METADATA_MARKER);
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const candidate = raw as {
    readonly approvalId?: unknown;
    readonly approval?: unknown;
    readonly kind?: unknown;
  };
  if (
    typeof candidate.approvalId !== 'string' ||
    (candidate.kind !== 'fix' && candidate.kind !== 'review')
  ) {
    return null;
  }
  if (candidate.approval === undefined) {
    return {
      approvalId: candidate.approvalId,
      kind: candidate.kind,
      approval: null,
    };
  }
  if (typeof candidate.approval !== 'object' || candidate.approval === null) {
    return null;
  }
  const approval = candidate.approval as {
    readonly actorLogin?: unknown;
    readonly approvedAt?: unknown;
    readonly eventId?: unknown;
    readonly target?: unknown;
  };
  if (
    typeof approval.actorLogin !== 'string' ||
    typeof approval.approvedAt !== 'string' ||
    typeof approval.eventId !== 'number' ||
    typeof approval.target !== 'string'
  ) {
    return null;
  }
  return {
    approvalId: candidate.approvalId,
    kind: candidate.kind,
    approval: {
      actorLogin: approval.actorLogin,
      approvedAt: approval.approvedAt,
      eventId: approval.eventId,
      target: approval.target,
    },
  };
};

export const matchingTrustedQueueCommentIds = async (
  deps: JobDeps,
  issueNumber: number,
  approvalId: string,
  kind: PollerJobKind,
): Promise<ReadonlyArray<number>> => {
  const comments = await listIssueComments(deps.token, deps.repo, issueNumber);
  const ids: Array<number> = [];
  for (const comment of comments) {
    const marker = queueMarker(comment.body);
    if (marker?.approvalId === approvalId && marker.kind === kind) {
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

export const inspectQueuedAcknowledgement = async (options: {
  readonly deps: JobDeps;
  readonly item: IssueItem;
  readonly kind: PollerJobKind;
  readonly target: string;
  readonly blocksShortcut: (comment: IssueComment) => boolean;
}): Promise<boolean> => {
  const { deps, item, kind, target, blocksShortcut } = options;
  const expectedLabel = approvalLabelFor(kind);
  if (
    !hasLabel(item.labels, expectedLabel) ||
    hasLabel(item.labels, inProgressLabelFor(kind)) ||
    hasLabel(item.labels, NEEDS_CLARIFICATION)
  ) {
    return false;
  }
  const comments = await listIssueComments(deps.token, deps.repo, item.number);
  if (comments.some(blocksShortcut)) {
    return false;
  }
  const checkpoints: Array<ApprovalCheckpoint> = [];
  for (const comment of comments) {
    const marker = queueMarker(comment.body);
    if (
      marker?.kind === kind &&
      marker.approval !== null &&
      marker.approval.target === target
    ) {
      // biome-ignore lint/performance/noAwaitInLoops: role reads use the shared per-tick cache; marker authorship is a trust boundary.
      const role = await cachedCollaboratorRole(
        {
          token: deps.token,
          repo: deps.repo,
          issueNumber: item.number,
          roleCache: deps.roleCache,
        },
        comment.authorLogin,
      );
      if (isTrustedRole(role)) {
        checkpoints.push(marker.approval);
      }
    }
  }
  if (checkpoints.length === 0) {
    return false;
  }
  const event = await lastLabelEvent(
    deps.token,
    deps.repo,
    item.number,
    expectedLabel,
  );
  return (
    event !== null &&
    checkpoints.some(
      (checkpoint) =>
        checkpoint.eventId === event.id &&
        checkpoint.actorLogin === event.actorLogin &&
        checkpoint.approvedAt === event.createdAt,
    )
  );
};
