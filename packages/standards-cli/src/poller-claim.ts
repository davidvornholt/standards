import { randomUUID } from 'node:crypto';
import { hasLabel } from './github-label-identity';
import { type ApprovalBinding, readApprovalBinding } from './poller-approval';
import {
  hiddenCommentMetadata,
  parseHiddenCommentMetadata,
} from './poller-comment-metadata';
import {
  collaboratorRole,
  getIssue,
  type IssueComment,
  lastLabelEvent,
  listIssueComments,
} from './poller-github';
import { createComment, deleteComment } from './poller-github-write';
import {
  CLAIM_MARKER,
  CLAIM_METADATA_MARKER,
  FIX_IN_PROGRESS,
  isTrustedRole,
  REVIEW_IN_PROGRESS,
} from './poller-protocol';

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

const markerPayload = (body: string): unknown | null => {
  const hidden = parseHiddenCommentMetadata(body, CLAIM_METADATA_MARKER);
  if (hidden !== null) {
    return hidden;
  }
  if (!body.startsWith(`${CLAIM_MARKER}\n`)) {
    return null;
  }
  try {
    return JSON.parse(body.slice(CLAIM_MARKER.length + 1)) as unknown;
  } catch {
    return null;
  }
};

const parseMarker = (comment: IssueComment): ClaimMarker | null => {
  const payload = markerPayload(comment.body);
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const raw = payload as {
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
    claimEpoch: String(event.id),
  };
  const nonce = randomUUID();
  const markerId = await createComment(
    context.token,
    context.repo,
    context.issueNumber,
    markerBody({ ...provisional, nonce }),
  );
  const winner = await winningMarkerId(context, provisional);
  if (winner !== markerId) {
    await deleteComment(context.token, context.repo, markerId);
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
