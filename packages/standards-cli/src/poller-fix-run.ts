// One fix job: a maintainer-approved issue becomes a verified draft PR, a
// precise question, or an explicit failure — never silence. Every transition
// is written back to GitHub so the next tick (or a human) resumes from there.

import { join } from 'node:path';
import { runCodex } from './poller-codex';
import type { IssueItem } from './poller-github';
import { createDraftPullRequest } from './poller-github-pulls';
import { addLabels, createComment } from './poller-github-write';
import {
  askQuestion,
  failJob,
  type JobDeps,
  type JobLabels,
  type JobResult,
  jobPreamble,
  releaseLabels,
} from './poller-job-shared';
import { readFixOutcome } from './poller-outcome';
import { fixPrompt } from './poller-prompts';
import {
  APPROVED_FOR_FIX,
  APPROVED_FOR_REVIEW,
  branchNameForIssue,
  FIX_FAILED,
  FIX_IN_PROGRESS,
  type FixOutcome,
  forbiddenDiffPaths,
} from './poller-protocol';
import {
  changedPaths,
  commitCount,
  createWorktree,
  ensureCacheClone,
  lockedPathsOf,
  pushBranch,
  type Workspace,
} from './poller-workspace';

const FIX_LABELS: JobLabels = {
  approved: APPROVED_FOR_FIX,
  inProgress: FIX_IN_PROGRESS,
  failed: FIX_FAILED,
};

type FixJob = {
  readonly deps: JobDeps;
  readonly issue: IssueItem;
  readonly defaultBranch: string;
  readonly workspace: Workspace;
};

const finishFixedJob = async (
  job: FixJob,
  outcome: FixOutcome,
): Promise<string> => {
  const { deps, issue, workspace } = job;
  if (commitCount(workspace.dir, workspace.baseSha) === 0) {
    await failJob(
      deps,
      FIX_LABELS,
      issue.number,
      'run reported "fixed" but produced no commits',
    );
    return `#${issue.number}: failed (fixed without commits)`;
  }
  const forbidden = forbiddenDiffPaths(
    changedPaths(workspace.dir, workspace.baseSha),
    await lockedPathsOf(workspace.dir),
  );
  if (forbidden.length > 0) {
    await failJob(
      deps,
      FIX_LABELS,
      issue.number,
      `the fix modified protected paths, which automation must never do:\n${forbidden.map((path) => `- ${path}`).join('\n')}`,
    );
    return `#${issue.number}: failed (protected paths: ${forbidden.join(', ')})`;
  }
  const branch = branchNameForIssue(issue.number);
  pushBranch(workspace.dir, branch, deps.token, { force: true });
  const prNumber = await createDraftPullRequest(deps.token, deps.repo, {
    title: outcome.prTitle ?? '',
    body: outcome.prBody ?? '',
    head: branch,
    base: job.defaultBranch,
  });
  await createComment(
    deps.token,
    deps.repo,
    issue.number,
    `Opened draft PR #${prNumber} for this issue. Apply \`${APPROVED_FOR_REVIEW}\` on the PR to run the automated review-fix pass, or review it directly.`,
  );
  await releaseLabels(deps, FIX_LABELS, issue.number);
  return `#${issue.number}: opened draft PR #${prNumber}`;
};

const dispatchOutcome = async (
  job: FixJob,
  outcome: FixOutcome,
): Promise<string> => {
  const { deps, issue } = job;
  if (outcome.status === 'question') {
    await askQuestion(deps, FIX_LABELS, issue.number, outcome.question ?? '');
    return `#${issue.number}: asked a question`;
  }
  if (outcome.status === 'stale') {
    await createComment(
      deps.token,
      deps.repo,
      issue.number,
      `The finding no longer reproduces on ${job.defaultBranch}: ${outcome.summary}\nClosing is left to a maintainer.`,
    );
    await releaseLabels(deps, FIX_LABELS, issue.number);
    return `#${issue.number}: stale, needs human close`;
  }
  if (outcome.status === 'cannot-fix') {
    await failJob(deps, FIX_LABELS, issue.number, outcome.summary);
    return `#${issue.number}: cannot fix`;
  }
  return finishFixedJob(job, outcome);
};

export const runFixJob = async (
  deps: JobDeps,
  issue: IssueItem,
  defaultBranch: string,
): Promise<JobResult> => {
  const { config, token, repo } = deps;
  const preamble = await jobPreamble(deps, issue, FIX_LABELS);
  if (preamble.kind === 'rejected') {
    return { lines: [`#${issue.number}: approval rejected`], ranCodex: false };
  }
  if (preamble.kind === 'waiting') {
    return {
      lines: [`#${issue.number}: waiting on an answer`],
      ranCodex: false,
    };
  }
  await addLabels(token, repo, issue.number, [FIX_IN_PROGRESS]);
  const cacheClone = ensureCacheClone(config.cacheDir, repo, token);
  const workspace = createWorktree(
    cacheClone,
    defaultBranch,
    branchNameForIssue(issue.number),
    join(
      config.cacheDir,
      'work',
      `${repo.replace('/', '--')}-issue-${issue.number}`,
    ),
  );
  const job: FixJob = { deps, issue, defaultBranch, workspace };
  try {
    const run = runCodex(
      workspace.dir,
      fixPrompt({
        repo,
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body,
        answers: preamble.answers,
      }),
      config,
    );
    const outcome = run.succeeded ? await readFixOutcome(workspace.dir) : null;
    if (outcome === null) {
      await failJob(
        deps,
        FIX_LABELS,
        issue.number,
        run.failure ?? 'run wrote no valid outcome file',
      );
      return {
        lines: [`#${issue.number}: failed (no valid outcome)`],
        ranCodex: true,
      };
    }
    return { lines: [await dispatchOutcome(job, outcome)], ranCodex: true };
  } finally {
    workspace.cleanup();
  }
};
