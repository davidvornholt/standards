import { isRecord } from './github-settings-parse';
import type { ApprovalBinding } from './poller-approval';
import { parseHiddenCommentMetadata } from './poller-comment-metadata';
import { retainEarliestComment } from './poller-comment-reconciliation';
import {
  collaboratorRole,
  type IssueComment,
  listIssueComments,
} from './poller-github';
import { CLAIM_METADATA_MARKER, isTrustedRole } from './poller-protocol';

export type ClaimMarkerBinding = {
  readonly approval: ApprovalBinding;
  readonly claimLabel: string;
  readonly claimEpoch: string;
};

type ClaimMarker = ClaimMarkerBinding & {
  readonly nonce: string;
};

type ClaimContext = {
  readonly token: string | null;
  readonly repo: string;
  readonly issueNumber: number;
};

const isApprovalBinding = (value: unknown): value is ApprovalBinding =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.repo === 'string' &&
  typeof value.issueNumber === 'number' &&
  typeof value.eventId === 'number' &&
  typeof value.label === 'string' &&
  typeof value.actorLogin === 'string' &&
  typeof value.approvedAt === 'string' &&
  typeof value.target === 'string';

const parseMarker = (comment: IssueComment): ClaimMarker | null => {
  const payload = parseHiddenCommentMetadata(
    comment.body,
    CLAIM_METADATA_MARKER,
  );
  if (!isRecord(payload)) {
    return null;
  }
  if (
    typeof payload.claimLabel !== 'string' ||
    typeof payload.claimEpoch !== 'string' ||
    typeof payload.nonce !== 'string' ||
    !isApprovalBinding(payload.approval)
  ) {
    return null;
  }
  return {
    approval: payload.approval,
    claimLabel: payload.claimLabel,
    claimEpoch: payload.claimEpoch,
    nonce: payload.nonce,
  };
};

const trustedMarkers = async (
  context: ClaimContext,
  matches: (marker: ClaimMarker) => boolean,
): Promise<
  ReadonlyArray<{ readonly id: number; readonly marker: ClaimMarker }>
> => {
  const comments = await listIssueComments(
    context.token,
    context.repo,
    context.issueNumber,
  );
  const markers: Array<{ readonly id: number; readonly marker: ClaimMarker }> =
    [];
  for (const comment of comments) {
    const marker = parseMarker(comment);
    if (marker !== null && matches(marker)) {
      // biome-ignore lint/performance/noAwaitInLoops: claim authors must be checked against their current role; the usually-one-item list is deliberately fail-closed.
      const role = await collaboratorRole(
        context.token,
        context.repo,
        comment.authorLogin,
      );
      if (isTrustedRole(role)) {
        markers.push({ id: comment.id, marker });
      }
    }
  }
  return markers;
};

export const matchingTrustedClaimMarkerIds = async (
  context: ClaimContext,
  binding: ClaimMarkerBinding,
): Promise<ReadonlyArray<number>> =>
  (
    await trustedMarkers(
      context,
      (marker) =>
        marker.approval.id === binding.approval.id &&
        marker.claimLabel === binding.claimLabel &&
        marker.claimEpoch === binding.claimEpoch,
    )
  ).map(({ id }) => id);

export const reconcileTrustedClaimEpoch = async (
  context: ClaimContext,
  claimLabel: string,
  claimEpoch: string,
): Promise<void> => {
  const groups = new Map<string, Array<number>>();
  const markers = await trustedMarkers(
    context,
    (marker) =>
      marker.claimLabel === claimLabel && marker.claimEpoch === claimEpoch,
  );
  for (const { id, marker } of markers) {
    const ids = groups.get(marker.approval.id) ?? [];
    ids.push(id);
    groups.set(marker.approval.id, ids);
  }
  for (const ids of groups.values()) {
    // biome-ignore lint/performance/noAwaitInLoops: each group contains GitHub mutations and groups are deliberately reconciled serially.
    await retainEarliestComment(context, ids);
  }
};
