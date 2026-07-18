import { join } from 'node:path';
import type { ClaimBinding } from './poller-claim';
import { runCodex } from './poller-codex';
import type { PullRequest } from './poller-github-pulls';
import {
  askQuestion,
  failJob,
  type JobDeps,
  type JobLabels,
  type JobResult,
} from './poller-job-shared';
import { readReviewOutcome } from './poller-outcome';
import { reviewPrompt } from './poller-prompts';
import { finishReviewedJob } from './poller-review-publication';
import { validateReviewClaim } from './poller-review-state';
import { createWorktree, mergeBase } from './poller-workspace';

export const executeReviewJob = async (options: {
  readonly deps: JobDeps;
  readonly labels: JobLabels;
  readonly pr: PullRequest;
  readonly claim: ClaimBinding;
  readonly cacheClone: string;
  readonly answers: ReadonlyArray<string>;
}): Promise<JobResult> => {
  const { deps, labels, pr, claim, cacheClone, answers } = options;
  const reviewBase = mergeBase(cacheClone, pr.baseSha, pr.headSha);
  const workspace = createWorktree(
    cacheClone,
    pr.headSha,
    pr.headRef,
    join(
      deps.config.cacheDir,
      'work',
      `${deps.repo.replace('/', '--')}-pr-${pr.number}`,
    ),
  );
  try {
    const run = runCodex(
      workspace.dir,
      reviewPrompt({
        repo: deps.repo,
        prNumber: pr.number,
        title: pr.title,
        baseSha: reviewBase,
        answers,
      }),
      deps.config,
    );
    await validateReviewClaim({
      deps,
      pr,
      claim,
      plan: {
        approvalId: claim.approval.id,
        approvedHead: pr.headSha,
        publishedHead: pr.headSha,
        baseRef: pr.baseRef,
        baseSha: pr.baseSha,
        report: '',
        commits: 0,
        deferred: [],
      },
      expectedHead: pr.headSha,
      requireDraft: true,
    });
    const outcome = run.succeeded
      ? await readReviewOutcome(workspace.dir)
      : null;
    if (outcome === null) {
      await failJob(
        deps,
        labels,
        pr.number,
        run.failure ?? 'run wrote no valid outcome file',
      );
      return {
        lines: [`PR #${pr.number}: failed (no valid outcome)`],
        ranCodex: true,
      };
    }
    if (outcome.status === 'question') {
      await askQuestion(deps, labels, pr.number, outcome.question ?? '');
      return { lines: [`PR #${pr.number}: asked a question`], ranCodex: true };
    }
    if (outcome.status === 'cannot-review') {
      await failJob(deps, labels, pr.number, outcome.summary);
      return { lines: [`PR #${pr.number}: cannot review`], ranCodex: true };
    }
    return {
      lines: [
        await finishReviewedJob({
          deps,
          labels,
          pr,
          claim,
          workDir: workspace.dir,
          outcome,
        }),
      ],
      ranCodex: true,
    };
  } finally {
    workspace.cleanup();
  }
};
