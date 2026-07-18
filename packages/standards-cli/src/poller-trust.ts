// Trust decisions for poller jobs. Two questions, both answered from GitHub
// state and repository roles, never from configuration: did a maintainer
// approve this job, and which comments count as answers to the agent's
// questions? Everything else on a public repository is untrusted text.

import {
  collaboratorRole,
  type IssueComment,
  lastLabelEvent,
  listIssueComments,
} from './poller-github';
import { isTrustedRole, QUESTION_MARKER } from './poller-protocol';

export type RoleCache = Map<string, string>;

export type TrustContext = {
  readonly token: string | null;
  readonly repo: string;
  readonly issueNumber: number;
  readonly roleCache: RoleCache;
};

const cachedRole = async (
  context: TrustContext,
  username: string,
): Promise<string> => {
  const key = `${context.repo}:${username}`;
  const cached = context.roleCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const role = await collaboratorRole(context.token, context.repo, username);
  context.roleCache.set(key, role);
  return role;
};

// The actor who most recently applied the approval label must hold a trusted
// role right now. Returns null when trusted; otherwise the reason.
export const approvalProblem = async (
  context: TrustContext,
  label: string,
): Promise<string | null> => {
  const event = await lastLabelEvent(
    context.token,
    context.repo,
    context.issueNumber,
    label,
  );
  if (event === null) {
    return `no "${label}" label event found on ${context.repo}#${context.issueNumber}`;
  }
  const role = await cachedRole(context, event.actorLogin);
  if (!isTrustedRole(role)) {
    return `"${label}" on ${context.repo}#${context.issueNumber} was applied by ${event.actorLogin} (role: ${role}); only admin or maintain roles may approve automation`;
  }
  return null;
};

export type AnswerState = {
  readonly waiting: boolean;
  readonly answers: ReadonlyArray<string>;
};

const hasQuestionMarker = (comment: IssueComment): boolean =>
  comment.body.includes(QUESTION_MARKER);

// The marker is public, so a marker-bearing comment counts as the poller's
// question only when its author is trusted (the poller posts with a
// maintainer token). Otherwise anyone could re-post the marker after a real
// answer and park the job in "waiting" forever.
const lastTrustedQuestionIndex = async (
  context: TrustContext,
  comments: ReadonlyArray<IssueComment>,
): Promise<number> => {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (comment !== undefined && hasQuestionMarker(comment)) {
      // biome-ignore lint/performance/noAwaitInLoops: role lookups go through the shared per-tick cache; parallel lookups would race it and duplicate API reads.
      const role = await cachedRole(context, comment.authorLogin);
      if (isTrustedRole(role)) {
        return index;
      }
    }
  }
  return -1;
};

// Answers are trusted-role comments posted after the poller's latest
// question. With a question outstanding and no such comment yet, the job
// waits; comments from anyone else are ignored entirely and never reach a
// prompt.
export const answerState = async (
  context: TrustContext,
): Promise<AnswerState> => {
  const comments = await listIssueComments(
    context.token,
    context.repo,
    context.issueNumber,
  );
  const lastQuestionIndex = await lastTrustedQuestionIndex(context, comments);
  if (lastQuestionIndex === -1) {
    return { waiting: false, answers: [] };
  }
  const answers: Array<string> = [];
  const candidates = comments
    .slice(lastQuestionIndex + 1)
    .filter(
      (comment) =>
        !hasQuestionMarker(comment) && comment.authorLogin.length > 0,
    );
  for (const comment of candidates) {
    // biome-ignore lint/performance/noAwaitInLoops: role lookups go through the shared per-tick cache; parallel lookups would race it and duplicate API reads.
    const role = await cachedRole(context, comment.authorLogin);
    if (isTrustedRole(role)) {
      answers.push(comment.body);
    }
  }
  return { waiting: answers.length === 0, answers };
};
