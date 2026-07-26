import type { CodexRunResult } from './poller-codex';
import type { FixPublication } from './poller-fix-publication';
import { createComment } from './poller-github-write';
import {
  askQuestion,
  failJob,
  type JobLabels,
  releaseLabels,
} from './poller-job-shared';
import { readFixOutcome } from './poller-outcome';
import type { FixOutcome } from './poller-protocol';

export const readFixRunOutcome = (
  run: CodexRunResult,
  workDir: string,
  issueNumber: number,
): Promise<FixOutcome | null> =>
  run.succeeded ? readFixOutcome(workDir, issueNumber) : Promise.resolve(null);

export const handleNonFixedOutcome = async (
  job: FixPublication,
  labels: JobLabels,
  outcome: FixOutcome,
): Promise<string | null> => {
  const { deps, issue } = job;
  if (outcome.status === 'question') {
    await askQuestion(deps, labels, issue.number, outcome.question ?? '');
    return `#${issue.number}: asked a question`;
  }
  if (outcome.status === 'stale') {
    await createComment(
      deps.token,
      deps.repo,
      issue.number,
      `The finding no longer reproduces on ${job.defaultBranch}: ${outcome.summary}\nClosing is left to a maintainer.`,
    );
    await releaseLabels(deps, labels, issue.number);
    return `#${issue.number}: stale, needs human close`;
  }
  if (outcome.status === 'cannot-fix') {
    await failJob(deps, labels, issue.number, outcome.summary);
    return `#${issue.number}: cannot fix`;
  }
  return null;
};
