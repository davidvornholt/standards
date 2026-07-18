import { issueRevision } from './poller-approval';
import { type ClaimBinding, validateClaim } from './poller-claim';
import { type SealedFixOutput, sealFixOutput } from './poller-fix-output';
import { getIssue, type IssueItem } from './poller-github';
import {
  createDraftPullRequest,
  findOpenPullRequestForHead,
  getPullRequest,
  updatePullRequest,
} from './poller-github-pulls';
import { createComment } from './poller-github-write';
import {
  failJob,
  type JobDeps,
  type JobLabels,
  releaseLabels,
} from './poller-job-shared';
import {
  changedWorkspaceQualityManifests,
  lockedPathsOf,
} from './poller-protected-paths';
import {
  APPROVED_FOR_REVIEW,
  type FixOutcome,
  forbiddenDiffPaths,
} from './poller-protocol';
import {
  changedPaths,
  commitCount,
  pushBranch,
  type Workspace,
} from './poller-workspace';

export type FixPublication = {
  readonly deps: JobDeps;
  readonly issue: IssueItem;
  readonly defaultBranch: string;
  readonly claim: ClaimBinding;
  readonly branch: string;
};

const fixPullRequestBody = (output: SealedFixOutput): string =>
  `<!-- standards-poller:fix issue=${output.issueNumber} approval=${output.approvalId} head=${output.sealedHead} -->\n${output.body}`;

export const validateFixClaim = async (
  job: Pick<FixPublication, 'deps' | 'issue' | 'claim'>,
): Promise<void> => {
  const current = await getIssue(
    job.deps.token,
    job.deps.repo,
    job.issue.number,
  );
  const problem = await validateClaim(
    {
      token: job.deps.token,
      repo: job.deps.repo,
      issueNumber: job.issue.number,
    },
    job.claim,
    issueRevision(current),
  );
  if (problem !== null) {
    throw new Error(`publication blocked: ${problem}`);
  }
};

export const publishFixedOutput = async (
  job: FixPublication,
  labels: JobLabels,
  output: SealedFixOutput,
  push: (() => void) | null,
): Promise<string> => {
  const { deps, issue, branch } = job;
  await validateFixClaim(job);
  push?.();
  await validateFixClaim(job);
  const expectedBody = fixPullRequestBody(output);
  const existing = await findOpenPullRequestForHead(
    deps.token,
    deps.repo,
    branch,
  );
  let prNumber: number;
  if (existing === null) {
    prNumber = await createDraftPullRequest(deps.token, deps.repo, {
      title: output.title,
      body: expectedBody,
      head: branch,
      base: job.defaultBranch,
    });
  } else {
    const pr = await getPullRequest(deps.token, deps.repo, existing);
    if (
      pr.headRepo !== deps.repo ||
      pr.headRef !== branch ||
      pr.headSha !== output.sealedHead ||
      pr.baseRef !== job.defaultBranch ||
      !pr.body.startsWith(
        `<!-- standards-poller:fix issue=${issue.number} approval=${job.claim.approval.id} `,
      )
    ) {
      throw new Error(
        `existing PR #${existing} does not prove ownership of ${branch}`,
      );
    }
    await validateFixClaim(job);
    await updatePullRequest(deps.token, deps.repo, existing, {
      title: output.title,
      body: expectedBody,
    });
    prNumber = existing;
  }
  await validateFixClaim(job);
  await createComment(
    deps.token,
    deps.repo,
    issue.number,
    `Opened draft PR #${prNumber} for this issue. Apply \`${APPROVED_FOR_REVIEW}\` on the PR to run the automated review-fix pass, or review it directly.`,
  );
  await validateFixClaim(job);
  await releaseLabels(deps, labels, issue.number);
  return `#${issue.number}: opened draft PR #${prNumber}`;
};

export const finishFixedJob = async (
  job: FixPublication & { readonly workspace: Workspace },
  labels: JobLabels,
  outcome: FixOutcome,
): Promise<string> => {
  const { deps, issue, workspace, branch } = job;
  if (commitCount(workspace.dir, workspace.baseSha) === 0) {
    await failJob(
      deps,
      labels,
      issue.number,
      'run reported "fixed" but produced no commits',
    );
    return `#${issue.number}: failed (fixed without commits)`;
  }
  const paths = changedPaths(workspace.dir, workspace.baseSha);
  const forbidden = [
    ...forbiddenDiffPaths(paths, await lockedPathsOf(workspace.dir)),
    ...changedWorkspaceQualityManifests(
      workspace.dir,
      workspace.baseSha,
      paths,
    ),
  ];
  if (forbidden.length > 0) {
    await failJob(
      deps,
      labels,
      issue.number,
      `the fix modified protected paths, which automation must never do:\n${forbidden.map((path) => `- ${path}`).join('\n')}`,
    );
    return `#${issue.number}: failed (protected paths: ${forbidden.join(', ')})`;
  }
  const sealed = sealFixOutput(workspace.dir, {
    issueNumber: issue.number,
    approvalId: job.claim.approval.id,
    title: outcome.prTitle ?? '',
    body: outcome.prBody ?? '',
  });
  return publishFixedOutput(job, labels, sealed, () =>
    pushBranch(workspace.dir, {
      repo: deps.repo,
      branch,
      token: deps.token,
      expectedRemoteSha: '',
    }),
  );
};
