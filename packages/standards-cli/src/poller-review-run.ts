// One review job: a maintainer-approved draft PR gets a full review-fix
// cycle — lens fan-out inside the Codex run, fixes as new commits — then the
// poller posts the report, files deferred findings as issues, and flips the
// PR to ready. GitHub writes stay in deterministic poller code; the agent
// never holds credentials.

import { join } from 'node:path';
import { prRevision } from './poller-approval';
import { acquireClaim } from './poller-claim';
import { runCodex } from './poller-codex';
import { getIssue, type IssueItem } from './poller-github';
import { getPullRequest } from './poller-github-pulls';
import { addLabels } from './poller-github-write';
import {
  askQuestion,
  failJob,
  type JobDeps,
  type JobLabels,
  type JobResult,
  jobPreamble,
} from './poller-job-shared';
import { readReviewOutcome } from './poller-outcome';
import { reviewPrompt } from './poller-prompts';
import {
  APPROVED_FOR_REVIEW,
  REVIEW_FAILED,
  REVIEW_IN_PROGRESS,
} from './poller-protocol';
import {
  finishReviewedJob,
  validateReviewClaim,
} from './poller-review-publication';
import {
  createWorktree,
  ensureCacheClone,
  mergeBase,
} from './poller-workspace';

const REVIEW_LABELS: JobLabels = {
  approved: APPROVED_FOR_REVIEW,
  inProgress: REVIEW_IN_PROGRESS,
  failed: REVIEW_FAILED,
};

export const runReviewJob = async (
  deps: JobDeps,
  prItem: IssueItem,
): Promise<JobResult> => {
  const { config, token, repo } = deps;
  const pr = await getPullRequest(token, repo, prItem.number);
  const currentItem = await getIssue(token, repo, prItem.number);
  const preamble = await jobPreamble(
    deps,
    currentItem,
    REVIEW_LABELS,
    prRevision(pr.headSha),
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
    await validateReviewClaim(deps, pr.number, claim);
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
    const line = await finishReviewedJob({
      deps,
      labels: REVIEW_LABELS,
      pr,
      claim,
      workDir: workspace.dir,
      outcome,
    });
    return { lines: [line], ranCodex: true };
  } finally {
    workspace.cleanup();
  }
};
