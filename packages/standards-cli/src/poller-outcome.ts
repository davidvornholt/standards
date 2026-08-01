// Outcome-file parsing for poller Codex runs: the structured handoff the
// agent writes into its worktree. Strict validation — an outcome that fails
// any check is treated as no outcome at all, which routes the job to the
// explicit failure path instead of acting on half-trusted data.

import { existsSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNonEmptyString, isRecord } from './github-settings-parse';
import { hasClosingReferenceToIssue } from './poller-closing-reference';
import {
  type FixOutcome,
  OUTCOME_FILE,
  type ReviewOutcome,
  type ReviewThreadResolution,
} from './poller-protocol';

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: ReadonlyArray<string>,
): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const readOutcomeRaw = async (workDir: string): Promise<unknown | null> => {
  const path = join(workDir, OUTCOME_FILE);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  } finally {
    rmSync(path, { force: true });
  }
};

const FIX_STATUSES: ReadonlySet<string> = new Set([
  'fixed',
  'question',
  'stale',
  'cannot-fix',
]);

const REVIEW_STATUSES: ReadonlySet<string> = new Set([
  'reviewed',
  'question',
  'cannot-review',
]);

// Conventional Commit subject: squash merges promote the PR title to the
// commit subject on main, and no CI gate lints it, so this validation is
// the enforcement point for poller-authored PRs.
const PR_TITLE_PATTERN = /^[a-z]+(?:\([^)]+\))?!?: .+/u;

export const readFixOutcome = async (
  workDir: string,
  issueNumber: number,
): Promise<FixOutcome | null> => {
  const raw = await readOutcomeRaw(workDir);
  if (
    !isRecord(raw) ||
    typeof raw.status !== 'string' ||
    !FIX_STATUSES.has(raw.status) ||
    !isNonEmptyString(raw.summary)
  ) {
    return null;
  }
  const status = raw.status as FixOutcome['status'];
  if (status === 'question' && !isNonEmptyString(raw.question)) {
    return null;
  }
  if (
    status === 'fixed' &&
    !(
      isNonEmptyString(raw.prTitle) &&
      PR_TITLE_PATTERN.test(raw.prTitle) &&
      isNonEmptyString(raw.prBody) &&
      hasClosingReferenceToIssue(raw.prBody, issueNumber)
    )
  ) {
    return null;
  }
  return {
    status,
    summary: raw.summary,
    question: typeof raw.question === 'string' ? raw.question : undefined,
    prTitle: typeof raw.prTitle === 'string' ? raw.prTitle : undefined,
    prBody: typeof raw.prBody === 'string' ? raw.prBody : undefined,
  };
};

export const readReviewOutcome = async (
  workDir: string,
): Promise<ReviewOutcome | null> => {
  const raw = await readOutcomeRaw(workDir);
  if (
    !isRecord(raw) ||
    typeof raw.status !== 'string' ||
    !REVIEW_STATUSES.has(raw.status) ||
    !isNonEmptyString(raw.summary)
  ) {
    return null;
  }
  const status = raw.status as ReviewOutcome['status'];
  if (
    status === 'question' &&
    !(
      hasExactKeys(raw, ['question', 'status', 'summary']) &&
      isNonEmptyString(raw.question)
    )
  ) {
    return null;
  }
  if (status === 'question') {
    return {
      status,
      summary: raw.summary,
      question: raw.question as string,
    };
  }
  if (status === 'cannot-review' && !hasExactKeys(raw, ['status', 'summary'])) {
    return null;
  }
  if (status === 'cannot-review') {
    return {
      status,
      summary: raw.summary,
    };
  }
  const threadsToResolve = parseThreadsToResolve(raw.threadsToResolve);
  if (
    !(
      hasExactKeys(raw, ['report', 'status', 'summary', 'threadsToResolve']) &&
      isNonEmptyString(raw.report)
    ) ||
    threadsToResolve === null
  ) {
    return null;
  }
  return {
    status,
    summary: raw.summary,
    report: raw.report,
    threadsToResolve,
  };
};

const parseThreadsToResolve = (
  raw: unknown,
): ReadonlyArray<ReviewThreadResolution> | null => {
  if (!Array.isArray(raw)) {
    return null;
  }
  const result: Array<ReviewThreadResolution> = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (
      !(
        isRecord(entry) &&
        hasExactKeys(entry, ['threadId', 'verificationReply']) &&
        isNonEmptyString(entry.threadId) &&
        isNonEmptyString(entry.verificationReply)
      ) ||
      ids.has(entry.threadId)
    ) {
      return null;
    }
    ids.add(entry.threadId);
    result.push({
      threadId: entry.threadId,
      verificationReply: entry.verificationReply,
    });
  }
  return result;
};
