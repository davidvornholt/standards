import { prRevision } from './poller-approval';
import { type ClaimBinding, validateClaim } from './poller-claim';
import { collaboratorRole, listIssueComments } from './poller-github';
import { getPullRequest, type PullRequest } from './poller-github-pulls';
import { createComment } from './poller-github-write';
import type { JobDeps } from './poller-job-shared';
import { isTrustedRole } from './poller-protocol';
import {
  parseReviewPlan,
  type ReviewPublicationPlan,
  reviewPlanMarker,
} from './poller-review-output';

export const readReviewPlan = async (
  deps: JobDeps,
  pr: PullRequest,
): Promise<ReviewPublicationPlan | null> => {
  const comments = await listIssueComments(deps.token, deps.repo, pr.number);
  for (const comment of comments) {
    const plan = parseReviewPlan(comment.body);
    if (
      plan !== null &&
      plan.baseRef === pr.baseRef &&
      plan.baseSha === pr.baseSha &&
      (plan.approvedHead === pr.headSha || plan.publishedHead === pr.headSha)
    ) {
      // biome-ignore lint/performance/noAwaitInLoops: plan authorship is a publication trust boundary and must fail closed against the current role.
      const role = await collaboratorRole(
        deps.token,
        deps.repo,
        comment.authorLogin,
      );
      if (isTrustedRole(role)) {
        return plan;
      }
    }
  }
  return null;
};

export const validateReviewClaim = async (options: {
  readonly deps: JobDeps;
  readonly pr: PullRequest;
  readonly claim: ClaimBinding;
  readonly plan: ReviewPublicationPlan;
  readonly expectedHead: string;
  readonly requireDraft: boolean;
}): Promise<PullRequest> => {
  const { deps, pr, claim, plan, expectedHead, requireDraft } = options;
  const current = await getPullRequest(deps.token, deps.repo, pr.number);
  if (
    current.headSha !== expectedHead ||
    current.baseRef !== plan.baseRef ||
    current.baseSha !== plan.baseSha ||
    current.headRepo !== deps.repo ||
    (requireDraft && !current.draft)
  ) {
    throw new Error(
      'publication blocked: PR head, base, repository, or draft state changed',
    );
  }
  const problem = await validateClaim(
    { token: deps.token, repo: deps.repo, issueNumber: pr.number },
    claim,
    prRevision(plan.approvedHead),
  );
  if (problem !== null) {
    throw new Error(`publication blocked: ${problem}`);
  }
  return current;
};

export const publishReviewPlan = async (
  deps: JobDeps,
  pr: PullRequest,
  claim: ClaimBinding,
  plan: ReviewPublicationPlan,
): Promise<void> => {
  if (plan.approvalId !== claim.approval.id) {
    throw new Error('publication blocked: sealed review approval changed');
  }
  const existing = await readReviewPlan(deps, pr);
  if (existing !== null) {
    if (
      existing.approvalId !== plan.approvalId ||
      JSON.stringify(existing) !== JSON.stringify(plan)
    ) {
      throw new Error('publication blocked: a different review plan exists');
    }
    return;
  }
  await validateReviewClaim({
    deps,
    pr,
    claim,
    plan,
    expectedHead: plan.approvedHead,
    requireDraft: true,
  });
  await createComment(deps.token, deps.repo, pr.number, reviewPlanMarker(plan));
};
