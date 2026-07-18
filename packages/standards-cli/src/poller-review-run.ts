// One review job: a maintainer-approved draft PR gets a full review-fix
// cycle — lens fan-out inside the Codex run, fixes as new commits — then the
// poller posts the report, files deferred findings as issues, and flips the
// PR to ready. GitHub writes stay in deterministic poller code; the agent
// never holds credentials.

import { join } from 'node:path';
import { runCodex } from './poller-codex';
import type { IssueItem } from './poller-github';
import {
  createPullRequestReview,
  getPullRequest,
  markPullRequestReady,
  type PullRequest,
} from './poller-github-pulls';
import { addLabels, createIssue } from './poller-github-write';
import {
  askQuestion,
  failJob,
  type JobDeps,
  type JobLabels,
  type JobResult,
  jobPreamble,
  releaseLabels,
} from './poller-job-shared';
import { readReviewOutcome } from './poller-outcome';
import { reviewPrompt } from './poller-prompts';
import {
  APPROVED_FOR_REVIEW,
  DEFERRED_FINDING,
  forbiddenDiffPaths,
  REVIEW_FAILED,
  REVIEW_IN_PROGRESS,
  type ReviewOutcome,
} from './poller-protocol';
import {
  changedPaths,
  commitCount,
  createWorktree,
  ensureCacheClone,
  lockedPathsOf,
  mergeBase,
  pushBranch,
} from './poller-workspace';

const REVIEW_LABELS: JobLabels = {
  approved: APPROVED_FOR_REVIEW,
  inProgress: REVIEW_IN_PROGRESS,
  failed: REVIEW_FAILED,
};

const finishReviewedJob = async (
  deps: JobDeps,
  pr: PullRequest,
  workDir: string,
  outcome: ReviewOutcome,
): Promise<string> => {
  const commits = commitCount(workDir, pr.headSha);
  if (commits > 0) {
    const forbidden = forbiddenDiffPaths(
      changedPaths(workDir, pr.headSha),
      await lockedPathsOf(workDir),
    );
    if (forbidden.length > 0) {
      await failJob(
        deps,
        REVIEW_LABELS,
        pr.number,
        `review fixes modified protected paths:\n${forbidden.map((path) => `- ${path}`).join('\n')}`,
      );
      return `PR #${pr.number}: failed (protected paths)`;
    }
    pushBranch(workDir, pr.headRef, deps.token, { force: false });
  }
  await createPullRequestReview(
    deps.token,
    deps.repo,
    pr.number,
    `${outcome.report ?? ''}\n\n---\n${commits} fix commit(s) pushed by the automated review run.`,
  );
  const deferred = outcome.deferred ?? [];
  for (const finding of deferred) {
    // biome-ignore lint/performance/noAwaitInLoops: GitHub advises against concurrent write requests (secondary rate limits); mutations run sequentially on purpose.
    await createIssue(deps.token, deps.repo, {
      title: finding.title,
      body: `${finding.body}\n\nDeferred from the automated review of PR #${pr.number}.`,
      labels: [DEFERRED_FINDING],
    });
  }
  await markPullRequestReady(deps.token, pr.nodeId);
  await releaseLabels(deps, REVIEW_LABELS, pr.number);
  return `PR #${pr.number}: reviewed (${commits} fix commit(s), ${deferred.length} deferred issue(s)), marked ready`;
};

export const runReviewJob = async (
  deps: JobDeps,
  prItem: IssueItem,
): Promise<JobResult> => {
  const { config, token, repo } = deps;
  const preamble = await jobPreamble(deps, prItem, REVIEW_LABELS);
  if (preamble.kind === 'rejected') {
    return {
      lines: [`PR #${prItem.number}: approval rejected`],
      ranCodex: false,
    };
  }
  if (preamble.kind === 'waiting') {
    return {
      lines: [`PR #${prItem.number}: waiting on an answer`],
      ranCodex: false,
    };
  }
  const pr = await getPullRequest(token, repo, prItem.number);
  // Fork PRs are out of scope: their head branch lives in a repository the
  // poller must not push to, and pushing a same-named branch to the base repo
  // would fake a review. Fail explicitly instead of pretending.
  if (pr.headRepo !== repo) {
    await failJob(
      deps,
      REVIEW_LABELS,
      pr.number,
      `this PR's head branch lives in ${pr.headRepo || 'an unknown repository'}; automated review runs only support same-repository branches`,
    );
    return {
      lines: [`PR #${pr.number}: rejected (fork head)`],
      ranCodex: false,
    };
  }
  await addLabels(token, repo, prItem.number, [REVIEW_IN_PROGRESS]);
  const cacheClone = ensureCacheClone(config.cacheDir, repo, token);
  const reviewBase = mergeBase(cacheClone, pr.baseRef, pr.headSha);
  const workspace = createWorktree(
    cacheClone,
    pr.headSha,
    pr.headRef,
    join(config.cacheDir, 'work', `${repo.replace('/', '--')}-pr-${pr.number}`),
  );
  try {
    const run = runCodex(
      workspace.dir,
      reviewPrompt({
        repo,
        prNumber: pr.number,
        title: pr.title,
        baseSha: reviewBase,
        answers: preamble.answers,
      }),
      config,
    );
    const outcome = run.succeeded
      ? await readReviewOutcome(workspace.dir)
      : null;
    if (outcome === null) {
      await failJob(
        deps,
        REVIEW_LABELS,
        pr.number,
        run.failure ?? 'run wrote no valid outcome file',
      );
      return {
        lines: [`PR #${pr.number}: failed (no valid outcome)`],
        ranCodex: true,
      };
    }
    if (outcome.status === 'question') {
      await askQuestion(deps, REVIEW_LABELS, pr.number, outcome.question ?? '');
      return { lines: [`PR #${pr.number}: asked a question`], ranCodex: true };
    }
    if (outcome.status === 'cannot-review') {
      await failJob(deps, REVIEW_LABELS, pr.number, outcome.summary);
      return { lines: [`PR #${pr.number}: cannot review`], ranCodex: true };
    }
    const line = await finishReviewedJob(deps, pr, workspace.dir, outcome);
    return { lines: [line], ranCodex: true };
  } finally {
    workspace.cleanup();
  }
};
