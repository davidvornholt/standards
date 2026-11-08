// `standards land`: merge a pull request once the checks on its current head
// pass, squash-merging exactly that head, then delete its local branch and
// wait for the runs the merge starts. The prs skill describes the behavior.

import { afterMerge } from './land-after-merge';
import { type Checkout, deleteBranch, updateBase } from './land-cleanup';
import {
  currentBranch,
  EXIT_DONE,
  ghJson,
  git,
  type LandContext,
  LandError,
  type PullRequest,
  type Repository,
  resolvedPath,
  runVisibly,
  viewPr,
} from './land-context';
import { waitForChecks } from './land-wait';
import { ciDetector } from './land-workflows';

const TRAILING_SLASHES = /\/+$/u;

const openCheckout = (context: LandContext): Checkout => ({
  root: resolvedPath(git(context, 'rev-parse', '--show-toplevel')),
  current: currentBranch(context),
});

// Returns the exit code: 0 when done, 1 when nothing was merged, and 2 when
// the pull request merged but a run after the merge isn't green.
export const land = async (
  context: LandContext,
  selector: string | null,
  noWait: boolean,
): Promise<number> => {
  const checkout = openCheckout(context);
  if (selector === null && checkout.current === null) {
    throw new LandError('Detached HEAD: specify a PR number or branch.');
  }
  const repo = ghJson<Repository>(
    context,
    'repo',
    'view',
    '--json',
    'url,nameWithOwner,defaultBranchRef,deleteBranchOnMerge',
  );
  const pr = viewPr<PullRequest>(
    context,
    selector ?? checkout.current ?? '',
    repo,
  );
  if (!pr.url.startsWith(`${repo.url.replace(TRAILING_SLASHES, '')}/pull/`)) {
    throw new LandError('The PR belongs to another repository.');
  }
  if (pr.state === 'MERGED') {
    // Running land on a merged pull request only cleans up.
    deleteBranch(context, pr, repo, checkout);
    updateBase(context, pr.baseRefName);
    return EXIT_DONE;
  }
  if (pr.state !== 'OPEN') {
    throw new LandError(`PR #${pr.number} is ${pr.state}, not merged.`);
  }
  const ci = ciDetector(context, repo);
  const request = { prNumber: pr.number, repo, noWait, hasCi: ci.pullRequest };
  const head = await waitForChecks(context, request);
  // gh reports progress itself, so its output stays on the terminal.
  const merged = runVisibly(context, 'gh', [
    'pr',
    'merge',
    String(pr.number),
    '--repo',
    repo.url,
    '--squash',
    '--match-head-commit',
    head,
  ]);
  if (!merged) {
    throw new LandError(`PR #${pr.number} was not merged.`);
  }
  return afterMerge(context, {
    prNumber: pr.number,
    repo,
    checkout,
    hasCi: ci.commit,
  });
};
