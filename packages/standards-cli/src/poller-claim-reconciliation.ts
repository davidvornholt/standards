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

const claimGroupKey = (approvalId: string, claimEpoch: string): string =>
  JSON.stringify([approvalId, claimEpoch]);

const reconcileTrustedClaimGroups = async (
  context: ClaimContext,
  claimLabel: string,
): Promise<
  ReadonlyMap<
    string,
    {
      readonly markerIds: ReadonlyArray<number>;
      readonly retainedId: number | null;
    }
  >
> => {
  const groups = new Map<string, Array<number>>();
  const markers = await trustedMarkers(
    context,
    (marker) => marker.claimLabel === claimLabel,
  );
  for (const { id, marker } of markers) {
    const key = claimGroupKey(marker.approval.id, marker.claimEpoch);
    const ids = groups.get(key) ?? [];
    ids.push(id);
    groups.set(key, ids);
  }
  const reconciled = new Map<
    string,
    {
      readonly markerIds: ReadonlyArray<number>;
      readonly retainedId: number | null;
    }
  >();
  for (const [key, ids] of groups) {
    // biome-ignore lint/performance/noAwaitInLoops: each group contains GitHub mutations and groups are deliberately reconciled serially.
    const retainedId = await retainEarliestComment(context, ids);
    reconciled.set(key, { markerIds: ids, retainedId });
  }
  return reconciled;
};

export const reconcileTrustedClaimElection = async (
  context: ClaimContext,
  binding: ClaimMarkerBinding,
): Promise<{
  readonly markerIds: ReadonlyArray<number>;
  readonly retainedId: number | null;
}> => {
  const markers = await trustedMarkers(
    context,
    (marker) =>
      marker.approval.id === binding.approval.id &&
      marker.claimLabel === binding.claimLabel &&
      marker.claimEpoch === binding.claimEpoch,
  );
  const markerIds = markers.map(({ id }) => id);
  return {
    markerIds,
    retainedId: await retainEarliestComment(context, markerIds),
  };
};

export const reconcileTrustedClaimHistory = async (
  context: ClaimContext,
  claimLabel: string,
): Promise<void> => {
  await reconcileTrustedClaimGroups(context, claimLabel);
};
