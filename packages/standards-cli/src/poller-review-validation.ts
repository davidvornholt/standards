import { join } from 'node:path';
import type { PullRequest } from './poller-github-pulls';
import type { JobDeps } from './poller-job-shared';
import {
  changedPathsBetween,
  commitCountBetween,
  createValidationWorktree,
  isAncestor,
} from './poller-output-integrity';
import {
  changedWorkspaceQualityManifests,
  lockedPathsOf,
} from './poller-protected-paths';
import { forbiddenDiffPaths } from './poller-protocol';
import type { ReviewPublicationPlan } from './poller-review-output';

export const validateSealedReviewOutput = async (options: {
  readonly deps: JobDeps;
  readonly pr: PullRequest;
  readonly plan: ReviewPublicationPlan;
  readonly cloneDir: string;
}): Promise<void> => {
  const { deps, pr, plan, cloneDir } = options;
  if (
    plan.repo !== deps.repo ||
    plan.prNumber !== pr.number ||
    plan.baseRef !== pr.baseRef ||
    plan.baseSha !== pr.baseSha ||
    !isAncestor(cloneDir, plan.approvedHead, plan.publishedHead) ||
    commitCountBetween(cloneDir, plan.approvedHead, plan.publishedHead) !==
      plan.commits
  ) {
    throw new Error('publication blocked: sealed review identity changed');
  }
  const paths = changedPathsBetween(
    cloneDir,
    plan.approvedHead,
    plan.publishedHead,
  );
  const workspace = createValidationWorktree(
    cloneDir,
    plan.publishedHead,
    join(
      deps.config.cacheDir,
      'work',
      `${deps.repo.replace('/', '--')}-pr-${pr.number}-validate`,
    ),
  );
  try {
    const forbidden = [
      ...forbiddenDiffPaths(paths, await lockedPathsOf(workspace.dir)),
      ...changedWorkspaceQualityManifests(
        workspace.dir,
        plan.approvedHead,
        paths,
      ),
    ];
    if (forbidden.length > 0) {
      throw new Error(
        `publication blocked: sealed review modified protected paths:\n${forbidden.join('\n')}`,
      );
    }
  } finally {
    workspace.cleanup();
  }
};
