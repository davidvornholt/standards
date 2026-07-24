import { isRecord } from './github-settings-parse';
import { isGitObjectId } from './poller-output-integrity';
import type { ReviewThreadResolution } from './poller-protocol';
import type { ReviewPublicationPlan } from './poller-review-output';

const PLAN_KEYS = [
  'approvalId',
  'approvedHead',
  'baseRef',
  'baseSha',
  'commits',
  'prNumber',
  'publishedHead',
  'repo',
  'report',
  'threadsToResolve',
] as const;

const THREAD_KEYS = ['threadId', 'verificationReply'] as const;

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const parseThreadsToResolve = (
  value: unknown,
): ReadonlyArray<ReviewThreadResolution> | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const threads: Array<ReviewThreadResolution> = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (
      !(isRecord(entry) && hasExactKeys(entry, THREAD_KEYS)) ||
      typeof entry.threadId !== 'string' ||
      entry.threadId.length === 0 ||
      typeof entry.verificationReply !== 'string' ||
      entry.verificationReply.trim().length === 0 ||
      ids.has(entry.threadId)
    ) {
      return null;
    }
    ids.add(entry.threadId);
    threads.push({
      threadId: entry.threadId,
      verificationReply: entry.verificationReply,
    });
  }
  return threads;
};

export const parseReviewPlanValue = (
  raw: unknown,
): ReviewPublicationPlan | null => {
  const threadsToResolve = isRecord(raw)
    ? parseThreadsToResolve(raw.threadsToResolve)
    : null;
  if (
    !(isRecord(raw) && hasExactKeys(raw, PLAN_KEYS)) ||
    typeof raw.repo !== 'string' ||
    raw.repo.length === 0 ||
    typeof raw.prNumber !== 'number' ||
    !Number.isInteger(raw.prNumber) ||
    raw.prNumber < 1 ||
    typeof raw.approvalId !== 'string' ||
    raw.approvalId.length === 0 ||
    typeof raw.approvedHead !== 'string' ||
    typeof raw.publishedHead !== 'string' ||
    typeof raw.baseRef !== 'string' ||
    raw.baseRef.length === 0 ||
    typeof raw.baseSha !== 'string' ||
    !isGitObjectId(raw.approvedHead) ||
    !isGitObjectId(raw.publishedHead) ||
    !isGitObjectId(raw.baseSha) ||
    typeof raw.report !== 'string' ||
    raw.report.trim().length === 0 ||
    typeof raw.commits !== 'number' ||
    !Number.isInteger(raw.commits) ||
    raw.commits < 0 ||
    threadsToResolve === null
  ) {
    return null;
  }
  return { ...raw, threadsToResolve } as ReviewPublicationPlan;
};
