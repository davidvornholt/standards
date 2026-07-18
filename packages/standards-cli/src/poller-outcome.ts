// Outcome-file parsing for poller Codex runs: the structured handoff the
// agent writes into its worktree. Strict validation — an outcome that fails
// any check is treated as no outcome at all, which routes the job to the
// explicit failure path instead of acting on half-trusted data.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNonEmptyString, isRecord } from './github-settings-parse';
import {
  type DeferredFinding,
  type FixOutcome,
  OUTCOME_FILE,
  type ReviewOutcome,
} from './poller-protocol';

const readOutcomeRaw = async (workDir: string): Promise<unknown | null> => {
  const path = join(workDir, OUTCOME_FILE);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
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

// Conventional Commit subject: consumers lint PR titles in CI, so a
// malformed title is caught here instead of as a red check later.
const PR_TITLE_PATTERN = /^[a-z]+(?:\([^)]+\))?!?: .+/u;

export const readFixOutcome = async (
  workDir: string,
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
      isNonEmptyString(raw.prBody)
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
  if (status === 'question' && !isNonEmptyString(raw.question)) {
    return null;
  }
  if (status === 'reviewed' && !isNonEmptyString(raw.report)) {
    return null;
  }
  const deferred = parseDeferred(raw.deferred);
  if (deferred === null) {
    return null;
  }
  return {
    status,
    summary: raw.summary,
    question: typeof raw.question === 'string' ? raw.question : undefined,
    report: typeof raw.report === 'string' ? raw.report : undefined,
    deferred,
  };
};

const parseDeferred = (raw: unknown): ReadonlyArray<DeferredFinding> | null => {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const deferred: Array<DeferredFinding> = [];
  for (const entry of raw) {
    if (
      !(
        isRecord(entry) &&
        isNonEmptyString(entry.title) &&
        isNonEmptyString(entry.body)
      )
    ) {
      return null;
    }
    deferred.push({ title: entry.title, body: entry.body });
  }
  return deferred;
};
