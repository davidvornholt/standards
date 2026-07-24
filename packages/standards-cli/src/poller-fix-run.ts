// A maintainer-approved issue becomes a verified draft PR, question, or failure.

import { join } from 'node:path';
import { hasLabel } from './github-label-identity';
import { approvalIsCurrent, issueRevision } from './poller-approval';
import { startClaim, withClaimReleasedOnFailure } from './poller-claim';
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

const result = (issueNumber: number, message: string): JobResult => ({
  lines: [`#${issueNumber}: ${message}`],
  ranCodex: false,
});

const assertSealedOwnership = (
  sealed: NonNullable<ReturnType<typeof readSealedFixOutput>>,
  issueNumber: number,
  approvalId: string,
  branch: string,
): void => {
  if (sealed.issueNumber !== issueNumber || sealed.approvalId !== approvalId) {
    throw new Error(`sealed output on ${branch} has invalid ownership`);
  }
};

export const runFixJob = async (
  deps: JobDeps,
  issue: IssueItem,
  resolveDefaultBranch: () => Promise<string>,
  allowCodex = true,
): Promise<JobResult> => {
  const { config, token, repo } = deps;
  const currentIssue = await getIssue(token, repo, issue.number);
  if (!hasLabel(currentIssue.labels, APPROVED_FOR_FIX)) {
    return result(issue.number, 'approval no longer present; skipped');
  }
  const readTarget = async (): Promise<string> =>
    issueRevision(await getIssue(token, repo, issue.number));
  const preamble = await jobPreamble(deps, currentIssue, FIX_LABELS, {
    approved: issueRevision(currentIssue),
    readCurrent: readTarget,
  });
  if (preamble.kind === 'stale') {
    return result(issue.number, 'approval no longer present; skipped');
  }
  if (preamble.kind === 'rejected') {
    return result(issue.number, 'approval rejected');
  }
  if (preamble.kind === 'waiting') {
    return result(issue.number, 'waiting on an answer');
  }
  const defaultBranch = await resolveDefaultBranch();
  const cacheClone = ensureCacheClone(config.cacheDir, repo, token);
  const branch = branchNameForIssue(issue.number, preamble.approval.id);
  const sealed = readSealedFixOutput(cacheClone, branch);
  if (hasInvalidLocalOutput(sealed, cacheClone, branch)) {
    throw new Error(
      `refusing to overwrite ${branch}: it is not valid sealed output for this approval`,
    );
  }
  if (
    !(await approvalIsCurrent(
      { token, repo, issueNumber: issue.number },
      preamble.approval,
      readTarget,
    ))
  ) {
    return result(issue.number, 'approval generation changed; skipped');
  }
  if (sealed === null && !allowCodex) {
    await acknowledgeQueuedJob(deps, issue.number, preamble.approval, 'fix');
    return result(issue.number, 'waiting for run capacity');
  }
  const claim = await startClaim(deps, issue.number, preamble.approval, 'fix');
  if (claim === null) {
    return result(issue.number, 'another poller owns the claim');
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
    assertSealedOwnership(sealed, issue.number, claim.approval.id, branch);
    return {
      lines: [
        await withClaimReleasedOnFailure(deps, issue.number, claim, () =>
          publishFixedOutput(resumableJob, FIX_LABELS, sealed, null),
        ),
      ],
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
    const run = await runCodex({
      workDir: workspace.dir,
      gitCommonDir: cacheClone,
      prompt: fixPrompt({
        repo,
        issueNumber: issue.number,
        title: currentIssue.title,
        body: currentIssue.body,
        approvalId: claim.approval.id,
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
    const message =
      nonFixed ??
      (await withClaimReleasedOnFailure(deps, issue.number, claim, () =>
        finishFixedJob(job, FIX_LABELS, outcome),
      ));
    return {
      lines: [message],
      ranCodex: true,
    };
  } finally {
    workspace.cleanup();
  }
};
