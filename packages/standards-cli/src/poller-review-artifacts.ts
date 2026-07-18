import type { ClaimBinding } from './poller-claim';
import { repositoryIssueWithMarkerExists } from './poller-github-publication';
import {
  createPullRequestReview,
  markPullRequestReady,
  type PullRequest,
  pullRequestReviewWithMarkerExists,
} from './poller-github-pulls';
import { createIssue } from './poller-github-write';
import {
  type JobDeps,
  type JobLabels,
  releaseLabels,
} from './poller-job-shared';
import { DEFERRED_FINDING } from './poller-protocol';
import type { ReviewPublicationPlan } from './poller-review-output';
import { validateReviewClaim } from './poller-review-state';

const reviewMarker = (plan: ReviewPublicationPlan): string =>
  `<!-- standards-poller:review approval=${plan.approvalId} -->`;

const deferredMarker = (plan: ReviewPublicationPlan, index: number): string =>
  `<!-- standards-poller:deferred approval=${plan.approvalId} index=${index} -->`;

export const publishReviewArtifacts = async (options: {
  readonly deps: JobDeps;
  readonly labels: JobLabels;
  readonly pr: PullRequest;
  readonly claim: ClaimBinding;
  readonly plan: ReviewPublicationPlan;
}): Promise<string> => {
  const { deps, labels, pr, claim, plan } = options;
  const marker = reviewMarker(plan);
  const reviewExists = await pullRequestReviewWithMarkerExists({
    token: deps.token,
    repo: deps.repo,
    prNumber: pr.number,
    marker,
    commitId: plan.publishedHead,
  });
  if (!reviewExists) {
    await validateReviewClaim({
      deps,
      pr,
      claim,
      plan,
      expectedHead: plan.publishedHead,
      requireDraft: true,
    });
    await createPullRequestReview({
      token: deps.token,
      repo: deps.repo,
      prNumber: pr.number,
      body: `${plan.report}\n\n---\n${plan.commits} fix commit(s) pushed by the automated review run.\n\n${marker}`,
      commitId: plan.publishedHead,
    });
  }
  for (const [index, finding] of plan.deferred.entries()) {
    const issueMarker = deferredMarker(plan, index);
    // biome-ignore lint/performance/noAwaitInLoops: deferred issues are sequential GitHub writes and each is independently replay-safe.
    const exists = await repositoryIssueWithMarkerExists(
      deps.token,
      deps.repo,
      issueMarker,
    );
    if (!exists) {
      await validateReviewClaim({
        deps,
        pr,
        claim,
        plan,
        expectedHead: plan.publishedHead,
        requireDraft: true,
      });
      await createIssue(deps.token, deps.repo, {
        title: finding.title,
        body: `${issueMarker}\n${finding.body}\n\nDeferred from the automated review of PR #${pr.number}.`,
        labels: [DEFERRED_FINDING],
      });
    }
  }
  const current = await validateReviewClaim({
    deps,
    pr,
    claim,
    plan,
    expectedHead: plan.publishedHead,
    requireDraft: false,
  });
  if (current.draft) {
    await markPullRequestReady(deps.token, current.nodeId);
  }
  await validateReviewClaim({
    deps,
    pr,
    claim,
    plan,
    expectedHead: plan.publishedHead,
    requireDraft: false,
  });
  await releaseLabels(deps, labels, pr.number);
  return `PR #${pr.number}: reviewed (${plan.commits} fix commit(s), ${plan.deferred.length} deferred issue(s)), marked ready`;
};
