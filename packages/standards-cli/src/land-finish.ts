// Finishing a merge that land asked GitHub for: confirming that the pull
// request is merged, then cleaning up after it.

import { type Checkout, deleteBranch, updateBase } from './land-cleanup';
import {
  errorMessage,
  type LandContext,
  LandError,
  type PullRequest,
  type Repository,
  shortSha,
  sleep,
  viewPr,
} from './land-context';

const READ_BACK_ATTEMPTS = 3;

// What land knows when `gh pr merge` returns: whether gh reported success.
export type MergeAttempt = {
  readonly prNumber: number;
  readonly repo: Repository;
  readonly accepted: boolean;
};

// A successful `gh pr merge` doesn't mean the pull request is merged: where a
// merge queue is required, gh only adds it to the queue. A failed one doesn't
// mean it isn't: gh exits with an error when GitHub merges but its response is
// lost. So the state has to be read back, and a failed read-back is retried a
// few times, because it is usually a transient API error.
const readBack = async (
  context: LandContext,
  { prNumber, repo, accepted }: MergeAttempt,
  attempt = 1,
): Promise<PullRequest> => {
  try {
    return viewPr(context, String(prNumber), repo);
  } catch (error) {
    if (attempt >= READ_BACK_ATTEMPTS) {
      const doubt = accepted
        ? `Cannot confirm that PR #${prNumber} is merged: reading it back failed: ${errorMessage(error)}. GitHub accepted the merge, but the PR may only be queued.`
        : `Cannot tell whether PR #${prNumber} is merged: gh pr merge failed, and reading the PR back failed: ${errorMessage(error)}.`;
      throw new LandError(
        `${doubt} Run \`standards land ${prNumber}\` again to check, and to clean up once it is merged.`,
        { cause: error },
      );
    }
  }
  await sleep(context.pollDelayMs);
  return readBack(context, { prNumber, repo, accepted }, attempt + 1);
};

// Finishes the merge land just asked for. Only once the pull request is seen
// as merged is a problem from here on a warning. land doesn't wait for the
// runs the merge starts: an agent that has to act on a deploy watches that run
// itself.
export const finishMerge = async (
  context: LandContext,
  merge: MergeAttempt,
  checkout: Checkout,
): Promise<void> => {
  const { prNumber, repo, accepted } = merge;
  const pr = await readBack(context, merge);
  if (pr.state !== 'MERGED') {
    throw new LandError(
      accepted
        ? `GitHub accepted PR #${prNumber} but hasn't merged it yet. Run \`standards land ${prNumber}\` again once it has.`
        : `PR #${prNumber} was not merged.`,
    );
  }
  if (!accepted) {
    context.warn(
      `gh pr merge failed, but GitHub reports PR #${prNumber} as merged.`,
    );
  }
  const sha = pr.mergeCommit?.oid;
  if (sha) {
    context.print(`PR #${prNumber} is merged as ${shortSha(sha)}.`);
  }
  if (!repo.deleteBranchOnMerge) {
    context.warn(
      'GitHub keeps merged branches in this repository. Enable "Automatically delete head branches" in its settings.',
    );
  }
  try {
    deleteBranch(context, pr, repo, checkout);
    updateBase(context, pr.baseRefName);
  } catch (error) {
    context.warn(
      `PR #${prNumber} is merged, but local cleanup stopped: ${errorMessage(error)}`,
    );
  }
};
