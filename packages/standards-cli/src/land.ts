// `standards land`: merge a pull request once the checks on its current head
// pass, squash-merging exactly that head, then delete its local branch. The
// prs skill describes the behavior.

import {
  type Checkout,
  deleteBranch,
  finishMerge,
  updateBase,
} from './land-cleanup';
import {
  currentBranch,
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

// Throws a LandError when the pull request isn't merged, or when cleaning up
// after an earlier merge stops.
export const land = async (
  context: LandContext,
  selector: string | null,
  noWait: boolean,
): Promise<void> => {
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
    return;
  }
  if (pr.state !== 'OPEN') {
    throw new LandError(`PR #${pr.number} is ${pr.state}, not merged.`);
  }
  const request = {
    prNumber: pr.number,
    repo,
    noWait,
    hasCi: ciDetector(context, repo),
  };
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
  finishMerge(context, pr.number, repo, checkout);
};
