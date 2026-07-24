// One review job: a maintainer-approved draft PR gets a full review-fix
// cycle — lens fan-out inside the Codex run, fixes as new commits — then the
// poller posts the report, files deferred findings as issues, and flips the
// PR to ready. GitHub writes stay in deterministic poller code; the agent
// never holds credentials.

import { prRevision } from './poller-approval';
import { acquireClaim } from './poller-claim';
import { getIssue, type IssueItem } from './poller-github';
import { getPullRequest } from './poller-github-pulls';
import { addLabels } from './poller-github-write';
import {
  failJob,
  type JobDeps,
  type JobLabels,
  type JobResult,
  jobPreamble,
} from './poller-job-shared';
import {
  APPROVED_FOR_REVIEW,
  REVIEW_FAILED,
  REVIEW_IN_PROGRESS,
} from './poller-protocol';
import { reviewEligibility } from './poller-review-eligibility';
import { executeReviewJob } from './poller-review-execution';
import {
  readSealedReviewPlan,
  reviewOutputBranch,
} from './poller-review-output';
import { resumeReviewedJob } from './poller-review-publication';
import { publishReviewPlan, readReviewPlan } from './poller-review-state';
import { acknowledgeQueuedJob } from './poller-status';
import { ensureCacheClone, localBranchExists } from './poller-workspace';

const REVIEW_LABELS: JobLabels = {
  approved: APPROVED_FOR_REVIEW,
  inProgress: REVIEW_IN_PROGRESS,
  failed: REVIEW_FAILED,
};

const currentReviewPlan = readReviewPlan;

const hasInvalidLocalOutput = (
  plan: Awaited<ReturnType<typeof readReviewPlan>>,
  sealed: ReturnType<typeof readSealedReviewPlan>,
  cloneDir: string,
  branch: string,
): boolean =>
  plan === null && sealed === null && localBranchExists(cloneDir, branch);

export const runReviewJob = async (
  deps: JobDeps,
  prItem: IssueItem,
  allowCodex = true,
): Promise<JobResult> => {
  const { config, token, repo } = deps;
  const pr = await getPullRequest(token, repo, prItem.number);
  let plan = await currentReviewPlan(deps, pr);
  const currentItem = await getIssue(token, repo, prItem.number);
  const preamble = await jobPreamble(
    deps,
    currentItem,
    REVIEW_LABELS,
    prRevision(pr.baseRef, pr.baseSha, plan?.approvedHead ?? pr.headSha),
  );
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
  const eligibility = reviewEligibility({
    repo,
    pr,
    hasPlan: plan !== null,
  });
  if (eligibility.kind === 'rejected') {
    await failJob(deps, REVIEW_LABELS, pr.number, eligibility.message);
    return {
      lines: [`PR #${pr.number}: ${eligibility.result}`],
      ranCodex: false,
    };
  }
  const cacheClone = ensureCacheClone(config.cacheDir, repo, token);
  const outputBranch = reviewOutputBranch({
    repo,
    prNumber: pr.number,
    baseSha: pr.baseSha,
    approvedHead: plan?.approvedHead ?? pr.headSha,
    approvalId: preamble.approval.id,
  });
  const sealed = readSealedReviewPlan(cacheClone, outputBranch);
  if (hasInvalidLocalOutput(plan, sealed, cacheClone, outputBranch)) {
    throw new Error(`sealed output on ${outputBranch} is invalid`);
  }
  if (plan === null && sealed === null && !allowCodex) {
    await acknowledgeQueuedJob(deps, pr.number, preamble.approval, 'review');
    return {
      lines: [`PR #${pr.number}: waiting for run capacity`],
      ranCodex: false,
    };
  }
  await addLabels(token, repo, prItem.number, [REVIEW_IN_PROGRESS]);
  const claim = await acquireClaim(
    { token, repo, issueNumber: pr.number },
    preamble.approval,
    REVIEW_IN_PROGRESS,
  );
  if (claim === null) {
    return {
      lines: [`PR #${pr.number}: another poller owns the claim`],
      ranCodex: false,
    };
  }
  if (plan === null && sealed !== null) {
    await publishReviewPlan(deps, pr, claim, sealed);
    plan = sealed;
  }
  if (plan !== null) {
    return {
      lines: [
        await resumeReviewedJob({
          deps,
          labels: REVIEW_LABELS,
          pr,
          claim,
          plan,
          cloneDir: cacheClone,
        }),
      ],
      ranCodex: false,
    };
  }
  return executeReviewJob({
    deps,
    labels: REVIEW_LABELS,
    pr,
    claim,
    cacheClone,
    answers: preamble.answers,
  });
};
