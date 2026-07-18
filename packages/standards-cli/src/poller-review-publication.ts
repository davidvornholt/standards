import type { ClaimBinding } from './poller-claim';
import type { PullRequest } from './poller-github-pulls';
import { failJob, type JobDeps, type JobLabels } from './poller-job-shared';
import {
  changedWorkspaceQualityManifests,
  lockedPathsOf,
} from './poller-protected-paths';
import { forbiddenDiffPaths, type ReviewOutcome } from './poller-protocol';
import { publishReviewArtifacts } from './poller-review-artifacts';
import {
  type ReviewPublicationPlan,
  readSealedReviewPlan,
  reviewOutputBranch,
  sealReviewPlan,
} from './poller-review-output';
import { publishReviewPlan, validateReviewClaim } from './poller-review-state';
import { validateSealedReviewOutput } from './poller-review-validation';
import {
  changedPaths,
  commitCount,
  headSha,
  localBranchExists,
  pushBranch,
} from './poller-workspace';

const outputBranchFor = (plan: ReviewPublicationPlan): string =>
  reviewOutputBranch(plan);

export const resumeReviewedJob = async (options: {
  readonly deps: JobDeps;
  readonly labels: JobLabels;
  readonly pr: PullRequest;
  readonly claim: ClaimBinding;
  readonly plan: ReviewPublicationPlan;
  readonly cloneDir: string;
}): Promise<string> => {
  const { deps, labels, pr, claim, plan, cloneDir } = options;
  if (claim.approval.id !== plan.approvalId) {
    throw new Error('publication blocked: review plan approval changed');
  }
  const outputBranch = outputBranchFor(plan);
  const sealed = readSealedReviewPlan(cloneDir, outputBranch);
  if (sealed === null) {
    const detail = localBranchExists(cloneDir, outputBranch)
      ? 'is not valid sealed review output'
      : 'is missing';
    throw new Error(`publication blocked: ${outputBranch} ${detail}`);
  }
  if (JSON.stringify(sealed) !== JSON.stringify(plan)) {
    throw new Error('publication blocked: sealed review plan changed');
  }
  await validateSealedReviewOutput({ deps, pr, plan, cloneDir });
  if (pr.headSha === plan.approvedHead && plan.publishedHead !== pr.headSha) {
    await validateReviewClaim({
      deps,
      pr,
      claim,
      plan,
      expectedHead: plan.approvedHead,
      requireDraft: true,
    });
    pushBranch(cloneDir, {
      repo: deps.repo,
      branch: pr.headRef,
      token: deps.token,
      sourceRef: plan.publishedHead,
      expectedRemoteSha: plan.approvedHead,
    });
  }
  await validateReviewClaim({
    deps,
    pr,
    claim,
    plan,
    expectedHead: plan.publishedHead,
    requireDraft: false,
  });
  return publishReviewArtifacts({ deps, labels, pr, claim, plan });
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
  const paths = commits > 0 ? changedPaths(workDir, pr.headSha) : [];
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
  const plan: ReviewPublicationPlan = {
    repo: deps.repo,
    prNumber: pr.number,
    approvalId: claim.approval.id,
    approvedHead: pr.headSha,
    publishedHead: headSha(workDir),
    baseRef: pr.baseRef,
    baseSha: pr.baseSha,
    report: outcome.report ?? '',
    commits,
    deferred: outcome.deferred ?? [],
  };
  const outputBranch = outputBranchFor(plan);
  const sealedHead = sealReviewPlan(workDir, plan);
  pushBranch(workDir, {
    repo: deps.repo,
    branch: outputBranch,
    token: deps.token,
    expectedRemoteSha: '',
    sourceRef: sealedHead,
  });
  await publishReviewPlan(deps, pr, claim, plan);
  if (commits > 0) {
    await validateReviewClaim({
      deps,
      pr,
      claim,
      plan,
      expectedHead: plan.approvedHead,
      requireDraft: true,
    });
    pushBranch(workDir, {
      repo: deps.repo,
      branch: pr.headRef,
      token: deps.token,
      sourceRef: plan.publishedHead,
      expectedRemoteSha: plan.approvedHead,
    });
  }
  await validateReviewClaim({
    deps,
    pr,
    claim,
    plan,
    expectedHead: plan.publishedHead,
    requireDraft: true,
  });
  return publishReviewArtifacts({ deps, labels, pr, claim, plan });
};
