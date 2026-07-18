// Shared job plumbing for fix and review runs: the failure and question
// transitions are identical state-machine moves, parameterized only by which
// approval/progress/failure labels the job family uses.

import type { PollerConfig } from './poller-config';
import { addLabels, createComment, removeLabel } from './poller-github-write';
import {
  FAILURE_MARKER,
  NEEDS_CLARIFICATION,
  QUESTION_MARKER,
} from './poller-protocol';
import { answerState, approvalProblem, type RoleCache } from './poller-trust';

export type JobDeps = {
  readonly config: PollerConfig;
  readonly token: string | null;
  readonly repo: string;
  readonly roleCache: RoleCache;
};

export type JobResult = {
  readonly lines: ReadonlyArray<string>;
  readonly ranCodex: boolean;
};

export type JobLabels = {
  readonly approved: string;
  readonly inProgress: string;
  readonly failed: string;
};

const FAILURE_SNIPPET_LIMIT = 1500;

export type JobPreamble =
  | { readonly kind: 'rejected' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'go'; readonly answers: ReadonlyArray<string> };

// The shared front half of every job: verify the approval's actor, then
// resolve the question/answer state. Both job families make exactly these
// moves, differing only in which labels they use.
export const jobPreamble = async (
  deps: JobDeps,
  item: { readonly number: number; readonly labels: ReadonlyArray<string> },
  labels: JobLabels,
): Promise<JobPreamble> => {
  const trust = {
    token: deps.token,
    repo: deps.repo,
    issueNumber: item.number,
    roleCache: deps.roleCache,
  };
  const trustProblem = await approvalProblem(trust, labels.approved);
  if (trustProblem !== null) {
    await removeLabel(deps.token, deps.repo, item.number, labels.approved);
    await createComment(
      deps.token,
      deps.repo,
      item.number,
      `${FAILURE_MARKER}\nApproval not honored: ${trustProblem}`,
    );
    return { kind: 'rejected' };
  }
  const answers = await answerState(trust);
  if (item.labels.includes(NEEDS_CLARIFICATION)) {
    if (answers.waiting) {
      return { kind: 'waiting' };
    }
    await removeLabel(deps.token, deps.repo, item.number, NEEDS_CLARIFICATION);
  }
  return { kind: 'go', answers: answers.answers };
};

export const failJob = async (
  deps: JobDeps,
  labels: JobLabels,
  issueNumber: number,
  reason: string,
): Promise<void> => {
  await createComment(
    deps.token,
    deps.repo,
    issueNumber,
    `${FAILURE_MARKER}\nAutomated run failed and needs a human look:\n\n${reason.slice(0, FAILURE_SNIPPET_LIMIT)}\n\nRe-apply \`${labels.approved}\` after addressing this to retry.`,
  );
  await addLabels(deps.token, deps.repo, issueNumber, [labels.failed]);
  await removeLabel(deps.token, deps.repo, issueNumber, labels.approved);
  await removeLabel(deps.token, deps.repo, issueNumber, labels.inProgress);
};

export const askQuestion = async (
  deps: JobDeps,
  labels: JobLabels,
  issueNumber: number,
  question: string,
): Promise<void> => {
  await createComment(
    deps.token,
    deps.repo,
    issueNumber,
    `${QUESTION_MARKER}\n${question}`,
  );
  await addLabels(deps.token, deps.repo, issueNumber, [NEEDS_CLARIFICATION]);
  await removeLabel(deps.token, deps.repo, issueNumber, labels.inProgress);
};

// Also clears a failed-label left by an earlier attempt: a completed retry
// must not keep advertising "needs a human look".
export const releaseLabels = async (
  deps: JobDeps,
  labels: JobLabels,
  issueNumber: number,
): Promise<void> => {
  await removeLabel(deps.token, deps.repo, issueNumber, labels.approved);
  await removeLabel(deps.token, deps.repo, issueNumber, labels.inProgress);
  await removeLabel(deps.token, deps.repo, issueNumber, labels.failed);
};
