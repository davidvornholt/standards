import { createHash } from 'node:crypto';
import type { ClaimBinding } from './poller-claim';
import type { PullRequest } from './poller-github-pulls';
import type { JobDeps } from './poller-job-shared';
import type { ReviewThreadResolution } from './poller-protocol';
import type { ReviewPublicationPlan } from './poller-review-output';
import { validateReviewClaim } from './poller-review-state';
import {
  type ReviewThread,
  readReviewThread,
  replyToReviewThread,
  resolveReviewThread,
} from './poller-review-thread-api';

export const threadResolutionMarker = (
  plan: ReviewPublicationPlan,
  resolution: ReviewThreadResolution,
): string => {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        repo: plan.repo,
        prNumber: plan.prNumber,
        approvalId: plan.approvalId,
        threadId: resolution.threadId,
        verificationReply: resolution.verificationReply,
      }),
    )
    .digest('hex');
  return `<!-- standards-poller:thread-resolution approval=${plan.approvalId} operation=${digest} -->`;
};

const assertThreadTarget = (
  thread: ReviewThread,
  plan: ReviewPublicationPlan,
): void => {
  if (thread.repo !== plan.repo || thread.prNumber !== plan.prNumber) {
    throw new Error(
      `publication blocked: review thread ${thread.id} belongs to ${thread.repo}#${thread.prNumber}`,
    );
  }
};

export const publishReviewThreadResolutions = async (options: {
  readonly deps: JobDeps;
  readonly pr: PullRequest;
  readonly claim: ClaimBinding;
  readonly plan: ReviewPublicationPlan;
}): Promise<void> => {
  const { deps, pr, claim, plan } = options;
  for (const resolution of plan.threadsToResolve) {
    const marker = threadResolutionMarker(plan, resolution);
    const reply = `${resolution.verificationReply}\n\n${marker}`;
    // biome-ignore lint/performance/noAwaitInLoops: each thread write has its own immediate claim revalidation.
    let thread = await readReviewThread(deps.token, resolution.threadId);
    assertThreadTarget(thread, plan);
    if (!thread.viewerAuthoredBodies.includes(reply)) {
      await validateReviewClaim({
        deps,
        pr,
        claim,
        plan,
        expectedHead: plan.publishedHead,
        requireDraft: true,
      });
      await replyToReviewThread(deps.token, resolution.threadId, reply);
    }
    thread = await readReviewThread(deps.token, resolution.threadId);
    assertThreadTarget(thread, plan);
    if (!thread.viewerAuthoredBodies.includes(reply)) {
      throw new Error(
        `publication blocked: verification reply missing from review thread ${resolution.threadId}`,
      );
    }
    if (!thread.isResolved) {
      await validateReviewClaim({
        deps,
        pr,
        claim,
        plan,
        expectedHead: plan.publishedHead,
        requireDraft: true,
      });
      await resolveReviewThread(deps.token, resolution.threadId);
    }
  }
};
