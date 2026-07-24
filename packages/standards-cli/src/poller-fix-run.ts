// One fix job: a maintainer-approved issue becomes a verified draft PR, a
// precise question, or an explicit failure — never silence. Every transition
// is written back to GitHub so the next tick (or a human) resumes from there.

import { join } from 'node:path';
import { issueRevision } from './poller-approval';
import { acquireClaim } from './poller-claim';
import { runCodex } from './poller-codex';
import { handleNonFixedOutcome } from './poller-fix-outcome';
import { readSealedFixOutput } from './poller-fix-output';
import {
  type FixPublication,
  finishFixedJob,
  publishFixedOutput,
  validateFixClaim,
} from './poller-fix-publication';
import { getIssue, type IssueItem } from './poller-github';
import { addLabels } from './poller-github-write';
import {
  failJob,
  type JobDeps,
  type JobLabels,
  type JobResult,
  jobPreamble,
} from './poller-job-shared';
import { readFixOutcome } from './poller-outcome';
import { fixPrompt } from './poller-prompts';
import {
  APPROVED_FOR_FIX,
  branchNameForIssue,
  FIX_FAILED,
  FIX_IN_PROGRESS,
} from './poller-protocol';
import { acknowledgeQueuedJob } from './poller-status';
import {
  createWorktree,
  ensureCacheClone,
  localBranchExists,
  type Workspace,
} from './poller-workspace';

const FIX_LABELS: JobLabels = {
  approved: APPROVED_FOR_FIX,
  inProgress: FIX_IN_PROGRESS,
  failed: FIX_FAILED,
};

type FixJob = FixPublication & {
  readonly workspace: Workspace;
};

const hasInvalidLocalOutput = (
  sealed: ReturnType<typeof readSealedFixOutput>,
  cloneDir: string,
  branch: string,
): boolean => sealed === null && localBranchExists(cloneDir, branch);

export const runFixJob = async (
  deps: JobDeps,
  issue: IssueItem,
  defaultBranch: string,
  allowCodex = true,
): Promise<JobResult> => {
  const { config, token, repo } = deps;
  const currentIssue = await getIssue(token, repo, issue.number);
  const preamble = await jobPreamble(
    deps,
    currentIssue,
    FIX_LABELS,
    issueRevision(currentIssue),
  );
  if (preamble.kind === 'rejected') {
    return { lines: [`#${issue.number}: approval rejected`], ranCodex: false };
  }
  if (preamble.kind === 'waiting') {
    return {
      lines: [`#${issue.number}: waiting on an answer`],
      ranCodex: false,
    };
  }
  const cacheClone = ensureCacheClone(config.cacheDir, repo, token);
  const branch = branchNameForIssue(issue.number, preamble.approval.id);
  const sealed = readSealedFixOutput(cacheClone, branch);
  if (hasInvalidLocalOutput(sealed, cacheClone, branch)) {
    throw new Error(
      `refusing to overwrite ${branch}: it is not valid sealed output for this approval`,
    );
  }
  if (sealed === null && !allowCodex) {
    await acknowledgeQueuedJob(deps, issue.number, preamble.approval, 'fix');
    return {
      lines: [`#${issue.number}: waiting for run capacity`],
      ranCodex: false,
    };
  }
  await addLabels(token, repo, issue.number, [FIX_IN_PROGRESS]);
  const claim = await acquireClaim(
    { token, repo, issueNumber: issue.number },
    preamble.approval,
    FIX_IN_PROGRESS,
  );
  if (claim === null) {
    return {
      lines: [`#${issue.number}: another poller owns the claim`],
      ranCodex: false,
    };
  }
  const resumableJob = {
    deps,
    issue: currentIssue,
    defaultBranch,
    claim,
    branch,
    cloneDir: cacheClone,
  };
  if (sealed !== null) {
    if (
      sealed.issueNumber !== issue.number ||
      sealed.approvalId !== claim.approval.id
    ) {
      throw new Error(`sealed output on ${branch} has invalid ownership`);
    }
    return {
      lines: [await publishFixedOutput(resumableJob, FIX_LABELS, sealed, null)],
      ranCodex: false,
    };
  }
  const workspace = createWorktree(
    cacheClone,
    defaultBranch,
    branch,
    join(
      config.cacheDir,
      'work',
      `${repo.replace('/', '--')}-issue-${issue.number}`,
    ),
  );
  const job: FixJob = {
    ...resumableJob,
    issue: currentIssue,
    workspace,
  };
  try {
    const run = runCodex({
      workDir: workspace.dir,
      gitCommonDir: cacheClone,
      prompt: fixPrompt({
        repo,
        issueNumber: issue.number,
        title: currentIssue.title,
        body: currentIssue.body,
        answers: preamble.answers,
      }),
      config,
    });
    await validateFixClaim(job);
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
    const nonFixed = await handleNonFixedOutcome(job, FIX_LABELS, outcome);
    return {
      lines: [nonFixed ?? (await finishFixedJob(job, FIX_LABELS, outcome))],
      ranCodex: true,
    };
  } finally {
    workspace.cleanup();
  }
};
