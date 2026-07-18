import { join } from 'node:path';
import type { SealedFixOutput } from './poller-fix-output';
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

export const validateSealedFixOutput = async (
  job: {
    readonly deps: JobDeps;
    readonly issueNumber: number;
    readonly defaultBranch: string;
    readonly approvalId: string;
    readonly cloneDir: string;
  },
  output: SealedFixOutput,
): Promise<void> => {
  if (
    output.repo !== job.deps.repo ||
    output.issueNumber !== job.issueNumber ||
    output.approvalId !== job.approvalId ||
    !isAncestor(job.cloneDir, output.baseSha, job.defaultBranch) ||
    !isAncestor(job.cloneDir, output.baseSha, output.generatedHead) ||
    commitCountBetween(job.cloneDir, output.baseSha, output.generatedHead) !==
      output.commits
  ) {
    throw new Error('sealed fix output does not match this job');
  }
  const paths = changedPathsBetween(
    job.cloneDir,
    output.baseSha,
    output.generatedHead,
  );
  const workspace = createValidationWorktree(
    job.cloneDir,
    output.generatedHead,
    join(
      job.deps.config.cacheDir,
      'work',
      `${job.deps.repo.replace('/', '--')}-issue-${job.issueNumber}-validate`,
    ),
  );
  try {
    const forbidden = [
      ...forbiddenDiffPaths(paths, await lockedPathsOf(workspace.dir)),
      ...changedWorkspaceQualityManifests(workspace.dir, output.baseSha, paths),
    ];
    if (forbidden.length > 0) {
      throw new Error(
        `sealed fix output modified protected paths:\n${forbidden.join('\n')}`,
      );
    }
  } finally {
    workspace.cleanup();
  }
};
