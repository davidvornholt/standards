// `standards land`: merge a pull request once the checks on its current head
// pass, squash-merging exactly that head, then delete its local branch. It
// first needs a review-fix report on the head or a reason to skip one. The prs
// skill describes the behavior.

import { type Checkout, deleteBranch, updateBase } from './land-cleanup';
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
import { finishMerge } from './land-finish';
import { postNote, reviewNote, settledNote } from './land-review';
import { waitForChecks } from './land-wait';
import { ciDetector } from './land-workflows';

const TRAILING_SLASHES = /\/+$/u;

const openCheckout = (context: LandContext): Checkout => ({
  root: resolvedPath(git(context, 'rev-parse', '--show-toplevel')),
  current: currentBranch(context),
});

export type LandOptions = {
  readonly noWait: boolean;
  // Why the pull request needs no review-fix, or null without --no-review.
  readonly noReview: string | null;
};

export const land = async (
  context: LandContext,
  selector: string | null,
  { noWait, noReview }: LandOptions,
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
  const review = {
    prNumber: pr.number,
    repo,
    head: pr.headRefOid,
    noReview,
  };
  const note = reviewNote(context, review);
  const waiting = { ...context, deadline: Date.now() + context.waitMs };
  const settled = await waitForChecks(waiting, {
    prNumber: pr.number,
    repo,
    noWait,
    hasCi: ciDetector(waiting, repo, pr),
  });
  // Someone may have pushed while land waited.
  const finalNote = settledNote(context, review, note, settled);
  if (finalNote !== null) {
    postNote(context, review, finalNote);
  }
  // gh reports progress itself, so its output stays on the terminal.
  const accepted = runVisibly(context, 'gh', [
    'pr',
    'merge',
    String(pr.number),
    '--repo',
    repo.url,
    '--squash',
    '--match-head-commit',
    settled.head,
  ]);
  await finishMerge(context, { prNumber: pr.number, repo, accepted }, checkout);
};
