import { prRevision } from './poller-approval';
import { type ClaimBinding, validateClaim } from './poller-claim';
import {
  createPullRequestReview,
  getPullRequest,
  markPullRequestReady,
  type PullRequest,
} from './poller-github-pulls';
import { createIssue } from './poller-github-write';
import {
  failJob,
  type JobDeps,
  type JobLabels,
  releaseLabels,
} from './poller-job-shared';
import {
  changedWorkspaceQualityManifests,
  lockedPathsOf,
} from './poller-protected-paths';
import {
  DEFERRED_FINDING,
  forbiddenDiffPaths,
  type ReviewOutcome,
} from './poller-protocol';
import { changedPaths, commitCount, pushBranch } from './poller-workspace';

export const validateReviewClaim = async (
  deps: JobDeps,
  prNumber: number,
  claim: ClaimBinding,
): Promise<void> => {
  const current = await getPullRequest(deps.token, deps.repo, prNumber);
  const problem = await validateClaim(
    { token: deps.token, repo: deps.repo, issueNumber: prNumber },
    claim,
    prRevision(current.headSha),
  );
  if (problem !== null) {
    throw new Error(`publication blocked: ${problem}`);
  }
};

export const finishReviewedJob = async (options: {
  readonly deps: JobDeps;
  readonly labels: JobLabels;
  readonly pr: PullRequest;
  readonly claim: ClaimBinding;
  readonly workDir: string;
  readonly outcome: ReviewOutcome;
}): Promise<string> => {
  const { deps, labels, pr, claim, workDir, outcome } = options;
  const commits = commitCount(workDir, pr.headSha);
  if (commits > 0) {
    const paths = changedPaths(workDir, pr.headSha);
    const forbidden = [
      ...forbiddenDiffPaths(paths, await lockedPathsOf(workDir)),
      ...changedWorkspaceQualityManifests(workDir, pr.headSha, paths),
    ];
    if (forbidden.length > 0) {
      await failJob(
        deps,
        labels,
        pr.number,
        `review fixes modified protected paths:\n${forbidden.map((path) => `- ${path}`).join('\n')}`,
      );
      return `PR #${pr.number}: failed (protected paths)`;
    }
    await validateReviewClaim(deps, pr.number, claim);
    pushBranch(workDir, {
      repo: deps.repo,
      branch: pr.headRef,
      token: deps.token,
    });
  }
  await validateReviewClaim(deps, pr.number, claim);
  await createPullRequestReview(
    deps.token,
    deps.repo,
    pr.number,
    `${outcome.report ?? ''}\n\n---\n${commits} fix commit(s) pushed by the automated review run.`,
  );
  const deferred = outcome.deferred ?? [];
  for (const finding of deferred) {
    // biome-ignore lint/performance/noAwaitInLoops: every publication boundary revalidates the exact approved PR head and current roles.
    await validateReviewClaim(deps, pr.number, claim);
    await createIssue(deps.token, deps.repo, {
      title: finding.title,
      body: `${finding.body}\n\nDeferred from the automated review of PR #${pr.number}.`,
      labels: [DEFERRED_FINDING],
    });
  }
  await validateReviewClaim(deps, pr.number, claim);
  await markPullRequestReady(deps.token, pr.nodeId);
  await validateReviewClaim(deps, pr.number, claim);
  await releaseLabels(deps, labels, pr.number);
  return `PR #${pr.number}: reviewed (${commits} fix commit(s), ${deferred.length} deferred issue(s)), marked ready`;
};
