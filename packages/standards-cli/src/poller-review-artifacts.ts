import type { ClaimBinding } from './poller-claim';
import { collaboratorRole } from './poller-github';
import {
  createPullRequestReview,
  markPullRequestReady,
  type PullRequest,
  pullRequestReviewMarkerAuthors,
} from './poller-github-pulls';
import {
  type JobDeps,
  type JobLabels,
  releaseLabels,
} from './poller-job-shared';
import { isTrustedRole } from './poller-protocol';
import type { ReviewPublicationPlan } from './poller-review-output';
import { validateReviewClaim } from './poller-review-state';
import { publishReviewThreadResolutions } from './poller-review-threads';

const reviewMarker = (plan: ReviewPublicationPlan): string =>
  `<!-- standards-poller:review repo=${plan.repo} pr=${plan.prNumber} approval=${plan.approvalId} -->`;

const hasTrustedAuthor = async (
  deps: JobDeps,
  authors: ReadonlyArray<string>,
): Promise<boolean> => {
  for (const author of new Set(authors)) {
    // biome-ignore lint/performance/noAwaitInLoops: marker authorship is a publication trust boundary and each role must be current.
    if (isTrustedRole(await collaboratorRole(deps.token, deps.repo, author))) {
      return true;
    }
  }
  return false;
};

export const publishReviewArtifacts = async (options: {
  readonly deps: JobDeps;
  readonly labels: JobLabels;
  readonly pr: PullRequest;
  readonly claim: ClaimBinding;
  readonly plan: ReviewPublicationPlan;
}): Promise<string> => {
  const { deps, labels, pr, claim, plan } = options;
  await publishReviewThreadResolutions({ deps, pr, claim, plan });
  const marker = reviewMarker(plan);
  const reviewExists = await hasTrustedAuthor(
    deps,
    await pullRequestReviewMarkerAuthors({
      token: deps.token,
      repo: deps.repo,
      prNumber: pr.number,
      marker,
      commitId: plan.publishedHead,
    }),
  );
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
  return `PR #${pr.number}: reviewed (${plan.commits} fix commit(s)), marked ready`;
};
